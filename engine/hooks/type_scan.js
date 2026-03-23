'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cnsFn = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var ci = NF('mono_class_get_image', 'pointer', ['pointer']);
var igd = NF('mono_image_get_filename', 'pointer', ['pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

send({ type: 'info', message: 'Scanning ALL GC handle objects by class name...' });

var classMap = {};
var totalCount = 0;
var errorCount = 0;

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    totalCount++;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var name = cnFn(k).readUtf8String();
        if (!name) return;

        if (classMap[name]) {
            classMap[name].count++;
            return;
        }

        var ns = '';
        var parent = '';
        var image = '';
        try { ns = cnsFn(k).readUtf8String(); } catch (e) {}
        try {
            var pk = cp(k);
            if (pk && !pk.isNull()) parent = cnFn(pk).readUtf8String();
        } catch (e) {}
        try {
            var img = ci(k);
            if (img && !img.isNull()) image = igd(img).readUtf8String();
        } catch (e) {}

        classMap[name] = {
            name: name,
            namespace: ns,
            parent: parent,
            image: image,
            count: 1
        };
    } catch (e) { errorCount++; }
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));

var sorted = Object.values(classMap).sort(function (a, b) { return b.count - a.count; });

var unityTypes = sorted.filter(function (e) { return e.namespace === 'UnityEngine' || e.namespace === 'TMPro'; });
var nkcTypes = sorted.filter(function (e) { return e.namespace === 'NKC' || e.namespace === 'NKM' || e.namespace === 'Bs' || e.namespace === 'Star'; });
var otherTypes = sorted.filter(function (e) { return e.namespace !== 'UnityEngine' && e.namespace !== 'TMPro' && e.namespace !== 'NKC' && e.namespace !== 'NKM' && e.namespace !== 'Bs' && e.namespace !== 'Star' && e.namespace !== ''; });

send({
    type: 'type_scan',
    total: totalCount,
    errors: errorCount,
    uniqueClasses: sorted.length,
    unityCount: unityTypes.length,
    nkcCount: nkcTypes.length,
    otherCount: otherTypes.length,
    top50: sorted.slice(0, 50).map(function (e) {
        return { n: e.name, ns: e.namespace, c: e.count, p: e.parent, img: e.image.split('\\').pop() };
    }),
    nkc: nkcTypes.map(function (e) {
        return { n: e.name, ns: e.namespace, c: e.count, p: e.parent, img: e.image.split('\\').pop() };
    }),
    other: otherTypes.filter(function (e) { return e.c >= 2; }).map(function (e) {
        return { n: e.name, ns: e.namespace, c: e.count, p: e.parent, img: e.image.split('\\').pop() };
    })
});

send({ type: 'done' });
