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

var domain = getRootDomain();
send('domain: ' + domain);

var thread = jitAttach(domain);
send('thread: ' + thread);

function readStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(8).readPointer().toInt32(); if (l > 0 && l < 100000) return o.add(16).readUtf16String(l); } catch(e) {}
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

function invoke(obj, klass, name, pcount) {
    var m = findMethod(klass, name, pcount);
    if (!m) return null;
    var exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    try { return ri(m, obj, ptr(0), exc); } catch(e) { send('err ' + name + ': ' + e); return null; }
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
    var klass = ogc(ta);
    var r = invoke(ta, klass, 'get_name', 0);
    send('ta_name: ' + (r ? readStr(r) : 'null'));
    r = invoke(ta, klass, 'get_text', 0);
    if (r && !r.isNull()) {
        var s = readStr(r);
        send('ta_text(len=' + (s ? s.length : 0) + '): ' + (s ? s.substring(0, 200) : 'null'));
    } else { send('ta_text: null'); }
}

if (tex) {
    var klass = ogc(tex);
    var r = invoke(tex, klass, 'get_name', 0);
    send('tex_name: ' + (r ? readStr(r) : 'null'));
    r = invoke(tex, klass, 'get_width', 0);
    send('tex_width: ' + (r ? r.toInt32() : 'null'));
    r = invoke(tex, klass, 'get_height', 0);
    send('tex_height: ' + (r ? r.toInt32() : 'null'));
    var enc = findMethod(klass, 'EncodeToPNG', 0);
    send('EncodeToPNG: ' + enc);
}

send('DONE');
