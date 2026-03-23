'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cns = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var gf = NF('mono_class_get_fields', 'pointer', ['pointer', 'pointer']);
var gnf = NF('mono_field_get_name', 'pointer', ['pointer']);
var gft = NF('mono_field_get_type', 'pointer', ['pointer']);
var tfn = NF('mono_type_get_name', 'pointer', ['pointer']);
var getFieldOffset = NF('mono_field_get_offset', 'int', ['pointer', 'pointer']);
var readArrLen = NF('mono_array_length', 'int', ['pointer']);
var readArrAddr = NF('mono_array_addr_with_size', 'pointer', ['pointer', 'int', 'int']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

function readMonoStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(16).readS32(); if (l > 0 && l < 10000000) return o.add(20).readUtf16String(l); } catch (e) {}
    return null;
}

function getFields(klass) {
    var iter = Memory.alloc(8);
    iter.writePointer(ptr(0));
    var fields = [];
    while (true) {
        var f = gf(klass, iter);
        if (!f || f.isNull()) break;
        fields.push(f);
    }
    return fields;
}

function dumpAllFields(obj, klass, depth) {
    if (depth > 1) return null;
    var n = cnFn(klass).readUtf8String();
    var ns = cns(klass).readUtf8String();
    var result = [];

    var fields = getFields(klass);
    for (var i = 0; i < fields.length; i++) {
        var fname = gnf(fields[i]).readUtf8String();
        var ft = gft(fields[i]);
        if (!ft || ft.isNull()) continue;
        var typeName = tfn(ft).readUtf8String();
        var offset = getFieldOffset(fields[i]);
        if (offset < 0 || offset > 100000) continue;

        if (typeName === 'System.String') {
            var strPtr = obj.add(offset).readPointer();
            var sv = readMonoStr(strPtr);
            if (sv) result.push({ name: fname, type: 'string', value: sv.substring(0, 120) });
        } else if (typeName === 'System.Int32') {
            result.push({ name: fname, type: 'int', value: obj.add(offset).readS32() });
        } else if (typeName === 'System.Int64' || typeName === 'System.UInt64') {
            result.push({ name: fname, type: 'long', value: obj.add(offset).readU64() });
        } else if (typeName === 'System.Boolean') {
            result.push({ name: fname, type: 'bool', value: obj.add(offset).readU8() !== 0 });
        } else if (typeName === 'System.Single') {
            result.push({ name: fname, type: 'float', value: obj.add(offset).readFloat() });
        } else if (typeName === 'System.Double') {
            result.push({ name: fname, type: 'double', value: obj.add(offset).readDouble() });
        } else {
            var childPtr = obj.add(offset).readPointer();
            if (childPtr && !childPtr.isNull()) {
                var childClass = ogc(childPtr);
                if (childClass && !childClass.isNull()) {
                    var childName = cnFn(childClass).readUtf8String();
                    result.push({ name: fname, type: 'ref', className: childName, ptr: childPtr.toString() });
                    if (depth < 1 && (childName === 'List`1' || childName.indexOf('[]') !== -1)) {
                        var len = readArrLen(childPtr);
                        if (len > 0 && len < 500) {
                            result.push({ name: fname + '[len]', type: 'int', value: len });
                            if (len > 0) {
                                var elemPtr = readArrAddr(childPtr, 0, Process.pointerSize);
                                if (elemPtr && !elemPtr.isNull()) {
                                    var elem = elemPtr.readPointer();
                                    if (elem && !elem.isNull()) {
                                        var elemClass = ogc(elem);
                                        if (elemClass && !elemClass.isNull()) {
                                            var elemName = cnFn(elemClass).readUtf8String();
                                            result.push({ name: fname + '[0].class', type: 'ref', className: elemName });
                                            var sub = dumpAllFields(elem, elemClass, depth + 1);
                                            if (sub) {
                                                for (var s = 0; s < sub.length; s++) {
                                                    result.push({ name: fname + '[0].' + sub[s].name, type: sub[s].type, value: sub[s].value });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                result.push({ name: fname, type: typeName, value: 'null' });
            }
        }
    }

    var parent = cp(klass);
    if (parent && !parent.isNull()) {
        var parentName = cnFn(parent).readUtf8String();
        if (parentName !== 'Object' && parentName !== 'ValueType' && parentName !== 'MonoBehaviour') {
            var parentFields = getFields(parent);
            for (var j = 0; j < parentFields.length; j++) {
                var pname = gnf(parentFields[j]).readUtf8String();
                var pft = gft(parentFields[j]);
                if (!pft || pft.isNull()) continue;
                var ptypeName = tfn(pft).readUtf8String();
                var poffset = getFieldOffset(parentFields[j]);
                if (poffset < 0 || poffset > 100000) continue;

                if (ptypeName === 'System.String') {
                    var strPtr = obj.add(poffset).readPointer();
                    var sv = readMonoStr(strPtr);
                    if (sv) result.push({ name: pname, type: 'string', value: sv.substring(0, 120) });
                } else if (ptypeName === 'System.Int32') {
                    result.push({ name: pname, type: 'int', value: obj.add(poffset).readS32() });
                } else if (ptypeName === 'System.Int64' || ptypeName === 'System.UInt64') {
                    result.push({ name: pname, type: 'long', value: obj.add(poffset).readU64() });
                }
            }
        }
    }

    return result;
}

function scanForIntervalIds() {
    var targets = ['DATE_OBSERVE', 'PICK_UP', 'SI_BANNER'];
    var found = [];

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;

            var fields = getFields(k);
            for (var i = 0; i < fields.length; i++) {
                var ft = gft(fields[i]);
                if (!ft || ft.isNull()) continue;
                var typeName = tfn(ft).readUtf8String();
                if (typeName !== 'System.String') continue;

                var offset = getFieldOffset(fields[i]);
                if (offset < 0 || offset > 100000) continue;
                var strPtr = t.add(offset).readPointer();
                var sv = readMonoStr(strPtr);
                if (!sv) continue;

                var svUpper = sv.toUpperCase();
                for (var ti = 0; ti < targets.length; ti++) {
                    if (svUpper.indexOf(targets[ti]) !== -1) {
                        var n = cnFn(k).readUtf8String();
                        var ns = cns(k).readUtf8String();
                        var dump = dumpAllFields(t, k, 0);
                        found.push({ className: n, namespace: ns, matchedField: gnf(fields[i]).readUtf8String(), matchedValue: sv, fields: dump });
                        break;
                    }
                }
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));

    send({
        type: 'interval_scan',
        count: found.length,
        results: found.slice(0, 10)
    });
}

setTimeout(function() {
    send({ type: 'status', msg: 'Scanning for banner IntervalId strings...' });
    scanForIntervalIds();
}, 2000);
