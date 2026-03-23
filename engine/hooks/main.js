'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var mfn = NF('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var ri = NF('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

var RESCAN_INTERVAL_MS = 10000;

function readMonoStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(16).readS32(); if (l > 0 && l < 10000000) return o.add(20).readUtf16String(l); } catch (e) {}
    return null;
}

function readMonoArrayBytes(o) {
    if (!o || o.isNull()) return null;
    try {
        var l = o.add(16).readU32();
        if (l === 0 || l > 50000000) return null;
        var dp = o.add(24).readPointer();
        if (!dp || dp.isNull()) return null;
        return { ptr: dp, length: l };
    } catch (e) {}
    return null;
}

function readBoxedInt(o) {
    if (!o || o.isNull()) return null;
    try { return o.add(16).readS32(); } catch (e) {}
    return null;
}

function findMethod(klass, name, pcount) {
    var c = klass;
    while (c && !c.isNull()) {
        try { var m = mfn(c, Memory.allocUtf8String(name), pcount); if (m && !m.isNull()) return m; } catch (e) {}
        c = cp(c);
    }
    return null;
}

function invoke(obj, klass, name, pcount) {
    var m = findMethod(klass, name, pcount);
    if (!m) return null;
    var exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    try { return ri(m, obj, ptr(0), exc); } catch (e) { return null; }
}

var seenPointers = {};
var targets = { Texture2D: [], TextAsset: [], Sprite: [] };
var scanCount = 0;
var autoRescan = false;
var rescanTimer = null;

function ptrKey(p) { return p.toString(); }

function collectAll() {
    var newTex = 0, newTa = 0, newSpr = 0;
    targets = { Texture2D: [], TextAsset: [], Sprite: [] };

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (n === 'Texture2D' || n === 'TextAsset' || n === 'Sprite') {
                var key = ptrKey(t);
                var isNew = !seenPointers[key];
                if (isNew) {
                    seenPointers[key] = true;
                    if (n === 'Texture2D') newTex++;
                    if (n === 'TextAsset') newTa++;
                    if (n === 'Sprite') newSpr++;
                }
                targets[n].push(t);
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    scanCount++;

    send({
        type: 'scan_done',
        scan: scanCount,
        Texture2D: targets.Texture2D.length,
        TextAsset: targets.TextAsset.length,
        Sprite: targets.Sprite.length,
        newTexture2D: newTex,
        newTextAsset: newTa,
        newSprite: newSpr,
        totalSeen: Object.keys(seenPointers).length
    });
}

recv('scan', function () {
    collectAll();
});

recv('extract_all', function () {
    extractTargets(false);
});

recv('extract_new', function () {
    extractTargets(true);
});

recv('start_auto', function () {
    if (autoRescan) return;
    autoRescan = true;
    send({ type: 'info', message: 'Auto-rescan enabled (every ' + (RESCAN_INTERVAL_MS / 1000) + 's). Browse the game to load more assets.' });
    rescanTimer = setInterval(function () {
        if (!autoRescan) { clearInterval(rescanTimer); return; }
        send({ type: 'info', message: 'Re-scanning Mono heap...' });
        collectAll();
    }, RESCAN_INTERVAL_MS);
});

recv('stop_auto', function () {
    autoRescan = false;
    if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
    send({ type: 'info', message: 'Auto-rescan disabled.' });
});

function extractTargets(newOnly) {
    var textures = [];
    var textAssets = [];
    var sprites = [];

    for (var i = 0; i < targets.Texture2D.length; i++) {
        try {
            var obj = targets.Texture2D[i];
            var key = ptrKey(obj);
            if (newOnly && seenPointers[key] === 'extracted') continue;
            seenPointers[key] = 'extracted';

            var klass = ogc(obj);
            var nameObj = invoke(obj, klass, 'get_name', 0);
            var name = readMonoStr(nameObj) || '';
            var w = readBoxedInt(invoke(obj, klass, 'get_width', 0)) || 0;
            var h = readBoxedInt(invoke(obj, klass, 'get_height', 0)) || 0;
            textures.push({ n: name, w: w, h: h });
        } catch (e) {}
    }
    if (textures.length > 0) send({ type: 'textures', data: textures });

    for (var i = 0; i < targets.TextAsset.length; i++) {
        try {
            var obj = targets.TextAsset[i];
            var key = ptrKey(obj);
            if (newOnly && seenPointers[key] === 'extracted') continue;
            seenPointers[key] = 'extracted';

            var klass = ogc(obj);
            var nameObj = invoke(obj, klass, 'get_name', 0);
            var name = readMonoStr(nameObj) || ('ta_' + i);

            var bytesResult = invoke(obj, klass, 'get_bytes', 0);
            if (bytesResult && !bytesResult.isNull()) {
                var arr = readMonoArrayBytes(bytesResult);
                if (arr && arr.length > 0) {
                    send({ type: 'ta_bin', index: i, name: name, size: arr.length }, arr.ptr.readByteArray(arr.length));
                    textAssets.push(name + ' [bin:' + arr.length + ']');
                    continue;
                }
            }

            var textObj = invoke(obj, klass, 'get_text', 0);
            if (textObj && !textObj.isNull()) {
                var str = readMonoStr(textObj);
                if (str && str.length > 0) {
                    send({ type: 'ta_text', index: i, name: name, text: str });
                    textAssets.push(name + ' [txt:' + str.length + ']');
                    continue;
                }
            }
            textAssets.push(name + ' [empty]');
        } catch (e) {}
    }

    for (var i = 0; i < targets.Sprite.length; i++) {
        try {
            var obj = targets.Sprite[i];
            var key = ptrKey(obj);
            if (newOnly && seenPointers[key] === 'extracted') continue;
            seenPointers[key] = 'extracted';

            var klass = ogc(obj);
            var nameObj = invoke(obj, klass, 'get_name', 0);
            var name = readMonoStr(nameObj) || '';
            sprites.push(name);
        } catch (e) {}
    }
    if (sprites.length > 0) send({ type: 'sprites', data: sprites });

    send({ type: 'done' });
}

send({ type: 'ready' });
