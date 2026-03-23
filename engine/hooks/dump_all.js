'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cnsFn = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var cf = NF('mono_class_get_fields', 'pointer', ['pointer', 'pointer']);
var ffn = NF('mono_field_get_name', 'pointer', ['pointer']);
var fot = NF('mono_field_get_offset', 'int', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var cis = NF('mono_class_instance_size', 'int', ['pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

var MAX_DUMP = 3000;
var MAX_FIELDS = 50;
var MAX_INSTANCE_SIZE = 4096;
var BATCH_SIZE = 100;

var dumped = 0;
var currentBatch = [];

send({ type: 'info', message: 'Dumping ALL GC handle objects with raw field data...' });

function flushBatch(idx) {
    if (currentBatch.length === 0) return;
    var copy = currentBatch.slice();
    currentBatch = [];
    send({ type: 'batch', index: idx, data: copy });
}

function safeReadFieldName(fp) {
    try { return ffn(fp).readUtf8String(); } catch (e) { return null; }
}

function safeReadFieldOffset(fp) {
    try { return fot(fp); } catch (e) { return -1; }
}

function safeGetInstanceSize(klass) {
    try { return cis(klass); } catch (e) { return 0; }
}

function safeReadU32(ptr, off) {
    try { return ptr.add(off).readU32(); } catch (e) { return 0; }
}
function safeReadS32(ptr, off) {
    try { return ptr.add(off).readS32(); } catch (e) { return 0; }
}
function safeReadFloat(ptr, off) {
    try { return ptr.add(off).readFloat(); } catch (e) { return 0; }
}

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    if (dumped >= MAX_DUMP) return;

    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var name = cnFn(k).readUtf8String();
        if (!name) return;

        var ns = '';
        var parent = '';
        var instSize = safeGetInstanceSize(k);
        try { ns = cnsFn(k).readUtf8String(); } catch (e) {}
        try { var pk = cp(k); if (pk && !pk.isNull()) parent = cnFn(pk).readUtf8String(); } catch (e) {}

        var fields = {};
        try {
            var iter = Memory.alloc(Process.pointerSize * 2);
            var fieldPtr = cf(k, iter);
            var fc = 0;
            while (fieldPtr && !fieldPtr.isNull() && fc < MAX_FIELDS) {
                var fname = safeReadFieldName(fieldPtr);
                var foffset = safeReadFieldOffset(fieldPtr);
                if (fname && foffset > 0 && foffset < instSize && foffset < MAX_INSTANCE_SIZE) {
                    var i32 = safeReadS32(t, foffset);
                    var u32 = safeReadU32(t, foffset);
                    var f32 = safeReadFloat(t, foffset);
                    if (i32 !== 0 || u32 !== 0 || f32 !== 0) {
                        fields[fname] = { o: foffset, i: i32, u: u32, f: parseFloat(f32.toFixed(4)) };
                    }
                }
                fc++;
                fieldPtr = fieldPtr.add(Process.pointerSize).readPointer();
            }
        } catch (e) {}

        dumped++;
        currentBatch.push({
            i: dumped,
            n: name,
            ns: ns,
            p: parent,
            sz: instSize,
            ptr: t.toString(),
            f: fields
        });

        if (currentBatch.length >= BATCH_SIZE) {
            flushBatch(Math.floor(dumped / BATCH_SIZE));
        }

        if (dumped % 500 === 0) {
            send({ type: 'progress', dumped: dumped });
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));
flushBatch(Math.floor(dumped / BATCH_SIZE) + 1);

send({
    type: 'dump_summary',
    totalDumped: dumped
});

send({ type: 'done' });
