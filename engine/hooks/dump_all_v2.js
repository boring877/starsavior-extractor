'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cnsFn = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var mfn = NF('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var ri = NF('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

function readMonoStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(16).readS32(); if (l > 0 && l < 10000000) return o.add(20).readUtf16String(l); } catch (e) {}
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

function hexStr(ptr, len) {
    if (!ptr || ptr.isNull()) return '<null>';
    var parts = [];
    for (var i = 0; i < Math.min(len, 64); i++) {
        parts.push(('0' + ptr.add(i).readU8().toString(16)).slice(-2));
    }
    return parts.join(' ');
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

send({ type: 'info', message: '=== Memory Asset Dump ===' });
send({ type: 'info', message: 'Scanning ALL objects for extractable data...' });

var results = { textAssets: 0, textures: 0, scriptableObjects: 0, monoBehaviours: 0, other: 0 };
var allText = [];

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var n = cnFn(k).readUtf8String();
        var ns = '';
        try { ns = cnsFn(k).readUtf8String(); } catch (e) {}

        if (n === 'TextAsset') {
            var nameObj = invoke(t, k, 'get_name', 0);
            var name = readMonoStr(nameObj) || '';
            if (!name) return;

            var bytesObj = invoke(t, k, 'get_bytes', 0);
            if (bytesObj && !bytesObj.isNull()) {
                var arr = readMonoArrayBytes(bytesObj);
                if (arr && arr.length > 0) {
                    results.textAssets++;
                    send({
                        type: 'ta_bin',
                        name: name,
                        size: arr.length,
                        data: arr.ptr.readByteArray(Math.min(arr.length, 102400))
                    });
                    return;
                }
            }

            var textObj = invoke(t, k, 'get_text', 0);
            if (textObj && !textObj.isNull()) {
                var str = readMonoStr(textObj);
                if (str && str.length > 0) {
                    results.textAssets++;
                    send({ type: 'ta_text', name: name, text: str.substring(0, 2000) });
                    allText.push({ name: name, text: str });
                    return;
                }
            }
        }

        if (n === 'Texture2D') {
            var nameObj = invoke(t, k, 'get_name', 0);
            var name = readMonoStr(nameObj) || '';
            if (!name) return;
            var w = invoke(t, k, 'get_width', 0);
            var h = invoke(t, k, 'get_height', 0);
            var wv = w && !w.isNull() ? w.add(16).readS32() : 0;
            var hv = h && !h.isNull() ? h.add(16).readS32() : 0;
            if (wv > 0 && hv > 0) {
                results.textures++;
                if (results.textures <= 20) {
                    send({ type: 'info', message: 'Texture2D: ' + name + ' (' + wv + 'x' + hv + ')' });
                }
            }
        }

        if (n === 'Sprite') {
            if (results.other <= 5) {
                var nameObj = invoke(t, k, 'get_name', 0);
                var name = readMonoStr(nameObj) || '';
                if (name) send({ type: 'info', message: 'Sprite: ' + name });
            }
            results.other++;
            return;
        }

        if (n === 'MonoBehaviour' || n === 'ScriptableObject' || n === 'GameObject') {
            results.monoBehaviours++;
            return;
        }

        if (ns === 'NKC' || ns === 'NKM' || ns === 'Bs') {
            results.scriptableObjects++;
            if (results.scriptableObjects <= 30) {
                var nameObj = invoke(t, k, 'get_name', 0);
                var name = readMonoStr(nameObj) || '(unnamed)';
                send({ type: 'info', message: ns + '.' + n + ': ' + name + ' (size:' + invoke(t, k, 'get_instance_size', 0).add(16).readS32() + ')' });
            }
            return;
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));

send({ type: 'done', results: results, textCount: allText.length });
