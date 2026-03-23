'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var mfn = NF('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var cm = NF('mono_compile_method', 'pointer', ['pointer']);
var cis = NF('mono_class_instance_size', 'int', ['pointer']);
var gffn = NF('mono_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
var gfo = NF('mono_field_get_offset', 'int', ['pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

function findMethod(klass, name, pcount) {
    var c = klass;
    while (c && !c.isNull()) {
        try { var m = mfn(c, Memory.allocUtf8String(name), pcount); if (m && !m.isNull()) return m; } catch (e) {}
        c = cp(c);
    }
    return null;
}

send({ type: 'info', message: '=== Passthrough Verification ===' });

var blendKlass = null;
var fsKlass = null;

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var n = cnFn(k).readUtf8String();
        if (n === 'PartialBitBlendReadStream' && !blendKlass) blendKlass = k;
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);
hf(cb, ptr(0));

if (!blendKlass) {
    send({ type: 'error', message: 'BlendStream not found' });
    send({ type: 'done' });
} else {
    send({ type: 'info', message: 'blendKlass size=' + cis(blendKlass) });

    var bsOff = gfo(gffn(blendKlass, Memory.allocUtf8String('baseStream')));

    var cb2 = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (n !== 'PartialBitBlendReadStream') return;
            var bsPtr = t.add(bsOff).readPointer();
            if (bsPtr && !bsPtr.isNull() && !fsKlass) {
                fsKlass = ogc(bsPtr);
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);
    hf(cb2, ptr(0));

        if (!fsKlass) {
        send({ type: 'error', message: 'FileStream class not found' });
        send({ type: 'done' });
    } else {
    send({ type: 'info', message: 'blendKlass size=' + cis(blendKlass) + ' fsKlass size=' + cis(fsKlass) });

    var bsOff = gfo(gffn(blendKlass, Memory.allocUtf8String('baseStream')));
    var readMethod = findMethod(blendKlass, 'Read', 3);
    var readAddr = cm(readMethod);

    var fsReadMethod = findMethod(fsKlass, 'Read', 3);
    var fsReadAddr = cm(fsReadMethod);

    send({ type: 'info', message: 'Blend.Read at ' + readAddr + ' FS.Read at ' + fsReadAddr });

    var fsPositionField = gffn(fsKlass, Memory.allocUtf8String('_readPos'));
    if (!fsPositionField) fsPositionField = gffn(fsKlass, Memory.allocUtf8String('_position'));

    var count = [0];
    var max = 6;

    Interceptor.attach(readAddr, {
        onLeave: function (retval) {
            var n = retval.toInt32();
            if (n <= 0 || count[0] >= max) return;
            this.afterData = this.buf.add(32 + this.offset).readByteArray(Math.min(n, 64));
        },
        onEnter: function (args) {
            if (count[0] >= max) return;
            this.buf = args[1];
            this.offset = args[2].toInt32();
            this.count = args[3].toInt32();
            this.streamPtr = args[0];

            var bsPtr = args[0].add(bsOff).readPointer();
            if (!bsPtr || bsPtr.isNull()) return;

            var filePos = '?';
            if (fsPositionField) {
                try { filePos = bsPtr.add(gfo(fsPositionField)).readS64(); } catch(e) {}
            }

            this.filePos = filePos;
            this.bundlePath = '';
        }
    });

    Interceptor.attach(fsReadAddr, {
        onEnter: function (args) {
            if (count[0] >= max) return;
            this.fsPtr = args[0];
            this.fsBuf = args[1];
            this.fsOffset = args[2].toInt32();
            this.fsCount = args[3].toInt32();
        },
        onLeave: function (retval) {
            if (count[0] >= max) return;
            var n = retval.toInt32();
            if (n <= 0) return;
            this.fsAfter = this.fsBuf.add(32 + this.fsOffset).readByteArray(Math.min(n, 64));
        }
    });

    var checkTimer = setInterval(function () {
        count[0]++;
        if (count[0] >= max) {
            clearInterval(checkTimer);
            send({ type: 'info', message: 'Captured enough' });
            send({ type: 'done' });
        }
    }, 2000);
}
