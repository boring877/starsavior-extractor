'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');

var NF = function(n, r, a) {
    try {
        var addr = mono.getExportByName(n);
        if (!addr || addr.isNull()) throw new Error('no export: ' + n);
        return new NativeFunction(addr, r, a);
    } catch(e) {
        send('NF fail ' + n + ': ' + e);
        return null;
    }
};

var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var rootDomain = NF('mono_get_root_domain', 'pointer', []);
var domain = rootDomain();
send('domain: ' + domain);

var mem = Memory.alloc(16);
Memory.writeU8(mem, 0);
var thread = jitAttach(mem);
send('thread: ' + thread);

var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cnsFn = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var mfn = NF('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var cm = NF('mono_compile_method', 'pointer', ['pointer']);
var ri = NF('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var gcN = NF('mono_gchandle_new', 'uint', ['pointer', 'int']);
var gcT = NF('mono_gchandle_get_target', 'pointer', ['uint']);

send('ri: ' + (ri ? 'ok' : 'fail'));

function readStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(8).readPointer().toInt32(); if (l > 0 && l < 100000) return o.add(16).readUtf16String(l); } catch(e) {}
    return null;
}

function readCStr(p) {
    if (!p || p.isNull()) return null;
    try { return p.readUtf8String(); } catch(e) {}
    return null;
}

function findMethod(klass, name, pcount) {
    var c = klass;
    while (c && !c.isNull()) {
        try {
            var m = mfn(c, Memory.allocUtf8String(name), pcount);
            if (m && !m.isNull()) return m;
        } catch(e) {}
        c = cp(c);
    }
    return null;
}

function invokeMethod(obj, klass, name, pcount) {
    var m = findMethod(klass, name, pcount);
    if (!m) { send('no method: ' + name); return null; }
    send('found ' + name + ': ' + m);

    var excBuf = Memory.alloc(8);
    Memory.writePointer(excBuf, ptr(0));

    send('calling ri...');
    try {
        var result = ri(m, obj, ptr(0), excBuf);
        send('ri result: ' + result);
        return result;
    } catch(e) {
        send('ri error: ' + e);
        return null;
    }
}

var tex = null;
var ta = null;
var cb = new NativeCallback(function(t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var n = cnFn(k).readUtf8String();
        if (n === 'Texture2D' && !tex) tex = t;
        if (n === 'TextAsset' && !ta) ta = t;
    } catch(e) {}
}, 'void', ['pointer', 'pointer']);
hf(cb, ptr(0));
send('tex: ' + tex + ' ta: ' + ta);

if (ta) {
    send('--- TextAsset test ---');
    var klass = ogc(ta);
    var result = invokeMethod(ta, klass, 'get_text', 0);
    if (result && !result.isNull()) {
        send('text: ' + readStr(result));
    }

    result = invokeMethod(ta, klass, 'get_name', 0);
    if (result && !result.isNull()) {
        send('name: ' + readStr(result));
    }
}

if (tex) {
    send('--- Texture2D test ---');
    var klass = ogc(tex);
    var result = invokeMethod(tex, klass, 'get_name', 0);
    if (result && !result.isNull()) {
        send('name: ' + readStr(result));
    }
}

send('DONE');
