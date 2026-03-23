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
jitAttach(domain);

function readStr(o) {
    if (!o || o.isNull()) return null;
    try {
        var hex = [];
        var raw = new Uint8Array(o.readByteArray(64));
        for (var i = 0; i < 64; i++) hex.push(('0' + raw[i].toString(16)).slice(-2));
        send('str_raw: ' + hex.join(' '));
        
        var l = o.add(16).readS32();
        send('str_len@16: ' + l);
        if (l > 0 && l < 100000) {
            var s = o.add(20).readUtf16String(l);
            send('str@20: ' + s);
            return s;
        }
        var l2 = o.add(8).readPointer().toInt32();
        send('str_len@8ptr: ' + l2);
        if (l2 > 0 && l2 < 100000) {
            var s2 = o.add(16).readUtf16String(l2);
            send('str@16: ' + s2);
            return s2;
        }
    } catch(e) { send('readStr err: ' + e); }
    return null;
}

function readInt(o) {
    if (!o || o.isNull()) return null;
    try { return o.add(16).readS32(); } catch(e) { return null; }
}

function findMethod(klass, name, pcount) {
    var c = klass;
    while (c && !c.isNull()) {
        try { var m = mfn(c, Memory.allocUtf8String(name), pcount); if (m && !m.isNull()) return m; } catch(e) {}
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
    try { var k = ogc(t); if (!k || k.isNull()) return; var n = cnFn(k).readUtf8String(); if (n === 'Texture2D' && !tex) tex = t; if (n === 'TextAsset' && !ta) ta = t; } catch(e) {}
}, 'void', ['pointer', 'pointer']);
hf(cb, ptr(0));
send('tex: ' + tex + ' ta: ' + ta);

if (ta) {
    var klass = ogc(ta);
    send('--- TextAsset ---');
    var r = invoke(ta, klass, 'get_name', 0);
    send('ta_name ptr: ' + r);
    send('ta_name: ' + readStr(r));
    r = invoke(ta, klass, 'get_text', 0);
    send('ta_text ptr: ' + r);
    send('ta_text: ' + readStr(r));
}

if (tex) {
    var klass = ogc(tex);
    send('--- Texture2D ---');
    var r = invoke(tex, klass, 'get_name', 0);
    send('tex_name: ' + readStr(r));
    r = invoke(tex, klass, 'get_width', 0);
    send('tex_width: ' + readInt(r));
    r = invoke(tex, klass, 'get_height', 0);
    send('tex_height: ' + readInt(r));
}

send('DONE');
