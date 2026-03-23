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

function dumpFields(obj, klass) {
    var fields = {};
    var instSize = cis(klass);
    try {
        var iter = Memory.alloc(Process.pointerSize * 2);
        var fieldPtr = cf(klass, iter);
        var fc = 0;
        while (fieldPtr && !fieldPtr.isNull() && fc < 60) {
            try {
                var fname = ffn(fieldPtr).readUtf8String();
                var foffset = fot(fieldPtr);
                if (fname && foffset > 0 && foffset < instSize) {
                    var rawPtr = obj.add(foffset).readPointer();
                    var ftPtr = ft(fieldPtr);
                    var tc = 0;
                    if (ftPtr && !ftPtr.isNull()) tc = ftk(ftPtr);

                    var entry = { o: foffset, tc: tc };

                    if (tc === 0x0A) entry.i = obj.add(foffset).readS32();
                    if (tc === 0x0E) entry.f = obj.add(foffset).readFloat();

                    if (tc === 0x1C || tc === 0x12 || tc === 0x15) {
                        var innerObj = rawPtr;
                        if (innerObj && !innerObj.isNull()) {
                            var innerK = ogc(innerObj);
                            if (innerK && !innerK.isNull()) {
                                var iname = cnFn(innerK).readUtf8String();
                                entry.t = iname;
                                if (iname === 'String') {
                                    var s = readMonoStr(innerObj);
                                    if (s) entry.v = s;
                                }
                                if (iname === 'Byte[]') {
                                    var arr = readMonoArrayBytes(innerObj);
                                    if (arr && arr.length > 0) {
                                        entry.len = arr.length;
                                        if (arr.length <= 256) {
                                            try { entry.hex = hexdump(arr.ptr, { length: Math.min(arr.length, 128), ansi: false }); } catch (e) {}
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (tc === 0x1D) {
                        try {
                            if (rawPtr && !rawPtr.isNull()) entry.alen = rawPtr.add(16).readU32();
                        } catch (e) {}
                    }

                    if (entry.i !== undefined || entry.f !== undefined || entry.v !== undefined || entry.len !== undefined) {
                        fields[fname] = entry;
                    }
                }
                fc++;
            } catch (e2) {}
            fieldPtr = fieldPtr.add(Process.pointerSize).readPointer();
        }
    } catch (e) {}
    return fields;
}

send({ type: 'info', message: '=== METHOD 1: AssetBundle object fields ===' });

var abData = [];
var abCb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var name = cnFn(k).readUtf8String();
        if (name !== 'AssetBundle') return;

        var nameObj = invoke(t, k, 'get_name', 0);
        var abName = readMonoStr(nameObj) || '(no name)';
        var fields = dumpFields(t, k);

        abData.push({ name: abName, fields: fields });
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(abCb, ptr(0));
send({ type: 'assetbundles', count: abData.length, bundles: abData });

send({ type: 'info', message: '=== METHOD 2: Bs.Addressable objects ===' });

var baData = [];
var baCb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var ns = '';
        try { ns = cnsFn(k).readUtf8String(); } catch (e) {}
        if (ns !== 'Bs.Addressable') return;
        var name = cnFn(k).readUtf8String();
        var fields = dumpFields(t, k);
        if (Object.keys(fields).length > 0) {
            baData.push({ name: name, fields: fields });
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(baCb, ptr(0));
send({ type: 'bs_addr', count: baData.length, objects: baData });

send({ type: 'info', message: '=== METHOD 3: NKC objects with interesting fields ===' });

var nkcData = [];
var nkcCb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var ns = '';
        try { ns = cnsFn(k).readUtf8String(); } catch (e) {}
        if (ns !== 'NKC') return;
        var name = cnFn(k).readUtf8String();
        var instSize = cis(k);

        var fields = {};
        var iter = Memory.alloc(Process.pointerSize * 2);
        var fieldPtr = cf(k, iter);
        var fc = 0;
        while (fieldPtr && !fieldPtr.isNull() && fc < 60) {
            try {
                var fname = ffn(fieldPtr).readUtf8String();
                var foffset = fot(fieldPtr);
                if (fname && foffset > 0 && foffset < instSize) {
                    var ftPtr = ft(fieldPtr);
                    var tc = 0;
                    if (ftPtr && !ftPtr.isNull()) tc = ftk(ftPtr);

                    if (tc === 0x1D) {
                        var rawPtr = t.add(foffset).readPointer();
                        try {
                            if (rawPtr && !rawPtr.isNull()) {
                                var alen = rawPtr.add(16).readU32();
                                if (alen >= 8 && alen <= 64) {
                                    var dp = rawPtr.add(24).readPointer();
                                    if (dp && !dp.isNull()) {
                                        fields[fname] = { o: foffset, len: alen, hex: hexdump(dp, { length: Math.min(alen, 64), ansi: false }) };
                                    }
                                }
                            }
                        } catch (e) {}
                    }

                    if (tc === 0x1C || tc === 0x12 || tc === 0x15) {
                        var rawPtr2 = t.add(foffset).readPointer();
                        try {
                            if (rawPtr2 && !rawPtr2.isNull()) {
                                var innerK = ogc(rawPtr2);
                                if (innerK && !innerK.isNull()) {
                                    var iname = cnFn(innerK).readUtf8String();
                                    if (iname === 'String') {
                                        var s = readMonoStr(rawPtr2);
                                        if (s && s.length >= 4) {
                                            var isAscii = true;
                                            for (var ci = 0; ci < Math.min(s.length, 20); ci++) {
                                                if (s.charCodeAt(ci) < 32 && s.charCodeAt(ci) !== 10) isAscii = false;
                                            }
                                            if (isAscii) fields[fname] = { o: foffset, t: 'String', v: s.substring(0, 200) };
                                        }
                                    }
                                    if (iname === 'Byte[]') {
                                        var arr = readMonoArrayBytes(rawPtr2);
                                        if (arr && arr.length >= 8 && arr.length <= 256) {
                                            fields[fname + '(bytes)'] = { o: foffset, len: arr.length, hex: hexdump(arr.ptr, { length: Math.min(arr.length, 64), ansi: false }) };
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
                fc++;
            } catch (e2) {}
            fieldPtr = fieldPtr.add(Process.pointerSize).readPointer();
        }

        if (Object.keys(fields).length > 0) {
            nkcData.push({ name: name, sz: instSize, fields: fields });
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(nkcCb, ptr(0));
send({ type: 'nkc', count: nkcData.length, objects: nkcData });

send({ type: 'done' });
