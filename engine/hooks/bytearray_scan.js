'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

send({ type: 'info', message: 'Scanning for Byte[] arrays in GC handles...' });

var byteArrays = [];
var totalCount = 0;

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    totalCount++;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var name = cnFn(k).readUtf8String();
        if (name === 'Byte[]') {
            try {
                var len = t.add(16).readU32();
                if (len > 0 && len <= 50000000) {
                    var dp = t.add(24).readPointer();
                    if (dp && !dp.isNull()) {
                        var preview = '';
                        var previewLen = Math.min(len, 64);
                        try {
                            preview = hexdump(dp, { length: previewLen, ansi: false });
                        } catch (e) {
                            preview = '(could not read)';
                        }
                        byteArrays.push({
                            ptr: t.toString(),
                            length: len,
                            preview: preview
                        });
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));

byteArrays.sort(function (a, b) { return b.length - a.length; });

var sizeBuckets = {};
for (var i = 0; i < byteArrays.length; i++) {
    var sz = byteArrays[i].length;
    var bucket;
    if (sz < 100) bucket = '< 100';
    else if (sz < 1000) bucket = '100-999';
    else if (sz < 10000) bucket = '1K-9K';
    else if (sz < 100000) bucket = '10K-99K';
    else if (sz < 1000000) bucket = '100K-999K';
    else bucket = '1M+';
    sizeBuckets[bucket] = (sizeBuckets[bucket] || 0) + 1;
}

send({
    type: 'bytearray_scan',
    total: totalCount,
    byteArrayCount: byteArrays.length,
    totalBytes: byteArrays.reduce(function (s, a) { return s + a.length; }, 0),
    sizeBuckets: sizeBuckets,
    arrays: byteArrays.map(function (a) {
        return { ptr: a.ptr, len: a.length, preview: a.preview };
    })
});

send({ type: 'info', message: 'Found ' + byteArrays.length + ' Byte[] arrays. Dumping largest ones...' });

var DUMP_MIN_SIZE = 50;
var MAX_DUMP_SIZE = 10000000;
var MAX_DUMPS = 50;
var dumpCount = 0;

for (var i = 0; i < byteArrays.length && dumpCount < MAX_DUMPS; i++) {
    var a = byteArrays[i];
    if (a.length < DUMP_MIN_SIZE || a.length > MAX_DUMP_SIZE) continue;
    dumpCount++;
    try {
        var data = a.ptr.sub(24).readPointer().readByteArray(Math.min(a.length, 500000));
        send({
            type: 'bytearray_data',
            index: i,
            ptr: a.ptr,
            length: a.length,
            size: a.length
        }, data);
    } catch (e) {
        send({ type: 'info', message: 'Failed to dump array #' + i + ' (' + a.length + ' bytes): ' + e });
    }
}

send({ type: 'done', dumpCount: dumpCount });
