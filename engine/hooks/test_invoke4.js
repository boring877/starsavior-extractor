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
var thread = jitAttach(domain);
send('domain: ' + domain + ' thread: ' + thread);

function readStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(8).readPointer().toInt32(); if (l > 0 && l < 100000) return o.add(16).readUtf16String(l); } catch(e) {}
    return null;
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
    if (!m) { send('no method: ' + name); return null; }
    var exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    var result = null;
    try { result = ri(m, obj, ptr(0), exc); } catch(e) { send('err ' + name + ': ' + e); return null; }
    var excVal = exc.readPointer();
    if (excVal && !excVal.isNull()) {
        send('EXCEPTION in ' + name + ': ' + excVal);
    }
    return result;
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
    var r = invoke(ta, klass, 'get_name', 0);
    send('ta_name raw: ' + r + ' str: ' + readStr(r));

    r = invoke(ta, klass, 'get_text', 0);
    send('ta_text raw: ' + r + ' str: ' + readStr(r));
}

if (tex) {
    var klass = ogc(tex);
    var r = invoke(tex, klass, 'get_name', 0);
    send('tex_name raw: ' + r + ' str: ' + readStr(r));

    r = invoke(tex, klass, 'get_width', 0);
    if (r && !r.isNull()) {
        send('tex_width raw ptr: ' + r);
        send('tex_width @+16: ' + r.add(16).readS32());
        send('tex_width @+0: ' + r.readS32());
    } else { send('tex_width: null'); }

    r = invoke(tex, klass, 'get_height', 0);
    if (r && !r.isNull()) {
        send('tex_height raw ptr: ' + r);
        send('tex_height @+16: ' + r.add(16).readS32());
        send('tex_height @+0: ' + r.readS32());
    } else { send('tex_height: null'); }
}

send('DONE');
