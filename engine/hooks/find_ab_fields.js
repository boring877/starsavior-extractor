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
var cf = NF('mono_class_get_fields', 'pointer', ['pointer', 'pointer']);
var ffn = NF('mono_field_get_name', 'pointer', ['pointer']);
var fot = NF('mono_field_get_offset', 'int', ['pointer']);
var ft = NF('mono_field_get_type', 'pointer', ['pointer']);
var ftk = NF('mono_type_get_full_type', 'uint32', ['pointer']);
var cis = NF('mono_class_instance_size', 'int', ['pointer']);

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

send({ type: 'info', message: 'Dumping AssetBundle fields...' });

var count = 0;
var interesting = 0;

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    count++;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var name = cnFn(k).readUtf8String();
        if (name !== 'AssetBundle') return;

        var nameObj = invoke(t, k, 'get_name', 0);
        var abName = readMonoStr(nameObj) || '(no name)';

        var instSize = cis(k);
        var iter = Memory.alloc(Process.pointerSize * 2);
        var fieldPtr = cf(k, iter);
        var fc = 0;

        while (fieldPtr && !fieldPtr.isNull() && fc < 50) {
            try {
                var fname = ffn(fieldPtr).readUtf8String();
                var foffset = fot(fieldPtr);
                if (fname && foffset > 0 && foffset < instSize) {
                    var ftPtr = ft(fieldPtr);
                    var tc = 0;
                    if (ftPtr && !ftPtr.isNull()) tc = ftk(ftPtr);

                    var rawPtr = t.add(foffset).readPointer();

                    if (tc === 0x1C || tc === 0x12 || tc === 0x15) {
                        var innerObj = rawPtr;
                        if (innerObj && !innerObj.isNull()) {
                            var innerK = ogc(innerObj);
                            if (innerK && !innerK.isNull()) {
                                var iname = cnFn(innerK).readUtf8String();
                                if (iname === 'String') {
                                    var s = readMonoStr(innerObj);
                                    if (s && s.length > 0) {
                                        interesting++;
                                        send({ type: 'ab_field', bundle: abName, field: fname, type: 'String', value: s.substring(0, 200) });
                                    }
                                }
                                if (iname === 'Byte[]') {
                                    var arr = readMonoArrayBytes(innerObj);
                                    if (arr && arr.length > 0) {
                                        interesting++;
                                        send({ type: 'ab_field', bundle: abName, field: fname, type: 'Byte[]', len: arr.length });
                                        if (arr.length <= 128) {
                                            var hex = hexdump(arr.ptr, { length: Math.min(arr.length, 64), ansi: false });
                                            send({ type: 'ab_hex', bundle: abName, field: fname, hex: hex });
                                        }
                                    }
                                }
                                if (iname !== 'String' && iname !== 'Byte[]') {
                                    interesting++;
                                    send({ type: 'ab_field', bundle: abName, field: fname, type: iname, ptr: rawPtr.toString() });
                                }
                            }
                        }
                    }

                    if (tc === 0x1D) {
                        try {
                            if (rawPtr && !rawPtr.isNull()) {
                                var alen = rawPtr.add(16).readU32();
                                if (alen > 0) {
                                    interesting++;
                                    send({ type: 'ab_field', bundle: abName, field: fname, type: 'Array', len: alen });
                                }
                            }
                        } catch (e) {}
                    }
                }
                fc++;
            } catch (e) {}
            fieldPtr = fieldPtr.add(Process.pointerSize).readPointer();
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));
send({ type: 'ab_done', total: count, interesting: interesting });
send({ type: 'done' });
