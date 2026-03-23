'use strict';

// Discovery hook: scan GC heap for ALL class names and find ones with DateTime fields
// This will help us identify the actual obfuscated names at runtime

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cns = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var gf = NF('mono_class_get_fields', 'pointer', ['pointer', 'pointer']);
var gnf = NF('mono_field_get_name', 'pointer', ['pointer']);
var gft = NF('mono_field_get_type', 'pointer', ['pointer']);
var tfn = NF('mono_type_get_name', 'pointer', ['pointer']);
var getFieldOffset = NF('mono_field_get_offset', 'int', ['pointer', 'pointer']);

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

// Scan 1: Find all classes that have DateTime fields
function findDateTimeClasses() {
    var classes = {};
    var seen = {};

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            var ns = cns(k).readUtf8String();
            var key = ns + '.' + n;
            if (seen[key]) return;
            seen[key] = true;

            var fields = getFields(k);
            for (var i = 0; i < fields.length; i++) {
                var ft = gft(fields[i]);
                if (!ft || ft.isNull()) continue;
                var typeName = tfn(ft).readUtf8String();
                if (typeName === 'System.DateTime') {
                    if (!classes[key]) classes[key] = [];
                    classes[key].push(gnf(fields[i]).readUtf8String());
                }
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return classes;
}

// Scan 2: Find all classes with string fields matching banner/gacha keywords
function findBannerStringClasses() {
    var targets = ['DATE_OBSERVE', 'PICK_UP', 'BANNER', 'GACHA', 'INTERVAL', 'SCHEDULE'];
    var found = [];
    var seen = {};

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
                        var key = ns + '.' + n;
                        if (!seen[key]) {
                            seen[key] = true;
                            found.push({
                                className: n,
                                namespace: ns,
                                matchedField: gnf(fields[i]).readUtf8String(),
                                matchedValue: sv.substring(0, 120)
                            });
                        }
                        break;
                    }
                }
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return found;
}

// Scan 3: Find classes that have fields of type "IntervalTime" (by class name)
// We need to find what IntervalTime is actually called at runtime
function findIntervalTimeType() {
    // First, find all unique field types that aren't primitives
    var refTypes = {};
    var seen = {};

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

                // Skip primitives and common types
                if (typeName.startsWith('System.') || typeName.startsWith('Unity.') || typeName.startsWith('TMPro.') || typeName.startsWith('UnityEngine.')) continue;

                var offset = getFieldOffset(fields[i]);
                if (offset < 0 || offset > 100000) continue;
                var refPtr = t.add(offset).readPointer();
                if (!refPtr || refPtr.isNull()) continue;

                var refClass = ogc(refPtr);
                if (!refClass || refClass.isNull()) continue;
                var refName = cnFn(refClass).readUtf8String();
                var refNs = cns(refClass).readUtf8String();
                var refKey = refNs + '.' + refName;

                // Check if this type has DateTime fields
                if (!seen[refKey]) {
                    seen[refKey] = true;
                    var refFields = getFields(refClass);
                    var hasDateTime = false;
                    var dtFieldNames = [];
                    for (var j = 0; j < refFields.length; j++) {
                        var rft = gft(refFields[j]);
                        if (!rft || rft.isNull()) continue;
                        var rtypeName = tfn(rft).readUtf8String();
                        if (rtypeName === 'System.DateTime') {
                            hasDateTime = true;
                            dtFieldNames.push(gnf(refFields[j]).readUtf8String());
                        }
                    }
                    if (hasDateTime) {
                        if (!refTypes[refKey]) refTypes[refKey] = { dateTimeFields: [], usedBy: [] };
                        refTypes[refKey].dateTimeFields = dtFieldNames;
                    }
                }

                // Track which classes use this type
                var parentName = cnFn(k).readUtf8String();
                var parentNs = cns(k).readUtf8String();
                var parentKey = parentNs + '.' + parentName;
                if (refTypes[refKey]) {
                    if (!refTypes[refKey].usedBy) refTypes[refKey].usedBy = [];
                    if (refTypes[refKey].usedBy.indexOf(parentKey) === -1) {
                        refTypes[refKey].usedBy.push(parentKey);
                    }
                }
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return refTypes;
}

setTimeout(function() {
    send({ type: 'status', msg: 'Scan 1: Finding classes with DateTime fields...' });
    var dtClasses = findDateTimeClasses();
    var dtKeys = Object.keys(dtClasses);
    send({ type: 'datetime_classes', count: dtKeys.length, classes: dtClasses });

    send({ type: 'status', msg: 'Scan 2: Finding classes with banner/gacha strings...' });
    var bannerClasses = findBannerStringClasses();
    send({ type: 'banner_classes', count: bannerClasses.length, results: bannerClasses });

    send({ type: 'status', msg: 'Scan 3: Finding reference types with DateTime fields (IntervalTime candidates)...' });
    var intervalCandidates = findIntervalTimeType();
    var iKeys = Object.keys(intervalCandidates);
    send({ type: 'interval_candidates', count: iKeys.length, candidates: intervalCandidates });

    send({ type: 'done', msg: 'Discovery complete.' });
}, 3000);
