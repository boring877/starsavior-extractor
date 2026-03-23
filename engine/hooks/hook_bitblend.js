'use strict';

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
var cis = NF('mono_class_instance_size', 'int', ['pointer']);
var cm = NF('mono_compile_method', 'pointer', ['pointer', 'pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

function hexStr(ptr, len) {
    if (!ptr || ptr.isNull()) return '<null>';
    var parts = [];
    for (var i = 0; i < Math.min(len, 128); i++) {
        parts.push(('0' + ptr.add(i).readU8().toString(16)).slice(-2));
    }
    return parts.join(' ');
}

function findMethod(klass, name, pcount) {
    var c = klass;
    while (c && !c.isNull()) {
        try { var m = mfn(c, Memory.allocUtf8String(name), pcount); if (m && !m.isNull()) return m; } catch (e) {}
        c = cp(c);
    }
    return null;
}

send({ type: 'info', message: '=== BitBlend Capture v2 ===' });

var xorStreamObj = null;
var xorStreamClass = null;
var blendStreamClass = null;

send({ type: 'info', message: 'Scanning GC handles...' });

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var n = cnFn(k).readUtf8String();
        if (n === 'PartialXorProcessStream' && !xorStreamObj) {
            xorStreamObj = t;
            xorStreamClass = k;
        }
        if (n === 'PartialBitBlendReadStream') {
            if (!blendStreamClass) blendStreamClass = k;
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));

if (!xorStreamObj || !blendStreamClass) {
    send({ type: 'error', message: 'Stream classes not found' });
    send({ type: 'done' });
} else {
    send({ type: 'info', message: 'Found XOR stream and Blend stream class' });

    var xorRead = findMethod(xorStreamClass, 'Read', 3);
    var blendRead = findMethod(blendStreamClass, 'Read', 3);
    send({ type: 'info', message: 'XOR Read: ' + (xorRead ? 'found' : 'NOT FOUND') });
    send({ type: 'info', message: 'Blend Read: ' + (blendRead ? 'found' : 'NOT FOUND') });

    var captureCount = [0];
    var MAX_CAPTURES = 5;

    function safeReadBuf(arg, name) {
        if (!arg || arg.isNull()) return null;
        try {
            var arr = arg;
            var len = arr.add(16).readU32();
            if (len > 0 && len < 50000000) {
                var dp = arr.add(24).readPointer();
                if (dp && !dp.isNull()) return { ptr: dp, length: len };
            }
        } catch (e) {}
        try {
            if (!arg.add(16).readU32().isNull()) {
                var len2 = arg.add(16).readU32();
                if (len2 > 0 && len2 < 50000000) {
                    var dp2 = arg.add(24).readPointer();
                    if (dp2 && !dp2.isNull()) return { ptr: dp2, length: len2 };
                }
            }
        } catch (e2) {}
        return null;
    }

    if (xorRead) {
        try {
            var addr = cm(xorRead, ptr(0));
            send({ type: 'info', message: 'Hooking XOR Read at ' + addr });
            Interceptor.attach(addr, {
                onEnter: function (args) {
                    if (captureCount[0] >= MAX_CAPTURES) return;
                    this._buf = args[1];
                    this._off = args[2].toInt32();
                    this._cnt = args[3].toInt32();
                    this._ok = false;
                    var info = safeReadBuf(args[1], 'xor');
                    if (info && info.length > 0) {
                        this._ptr = info.ptr;
                        this._len = info.length;
                        this._ok = true;
                    }
                },
                onLeave: function (retval) {
                    if (captureCount[0] >= MAX_CAPTURES) return;
                    var n = retval.toInt32();
                    if (n <= 0 || !this._ok) return;
                    var raw = this._ptr.readByteArray(Math.min(n, 1024));
                    send({ type: 'xor_read', offset: this._off, count: n, data: raw });
                    captureCount[0]++;
                    send({ type: 'info', message: 'XOR capture #' + captureCount[0] + ' (' + n + ' bytes)' });
                }
            });
            send({ type: 'info', message: 'XOR hook OK' });
        } catch (e) { send({ type: 'error', message: 'XOR hook: ' + e }); }
    }

    if (blendRead) {
        try {
            var addr2 = cm(blendRead, ptr(0));
            send({ type: 'info', message: 'Hooking Blend Read at ' + addr2 });
            Interceptor.attach(addr2, {
                onEnter: function (args) {
                    if (captureCount[0] >= MAX_CAPTURES * 2) return;
                    this._buf = args[1];
                    this._off = args[2].toInt32();
                    this._cnt = args[3].toInt32();
                    this._ok = false;
                    var info = safeReadBuf(args[1], 'blend');
                    if (info && info.length > 0) {
                        this._ptr = info.ptr;
                        this._len = info.length;
                        this._ok = true;
                    }
                },
                onLeave: function (retval) {
                    if (captureCount[0] >= MAX_CAPTURES * 2) return;
                    var n = retval.toInt32();
                    if (n <= 0 || !this._ok) return;
                    var raw = this._ptr.readByteArray(Math.min(n, 1024));
                    send({ type: 'blend_read', offset: this._off, count: n, data: raw });
                    send({ type: 'info', message: 'BLEND capture #' + Math.ceil(captureCount[0] / 2) + ' (' + n + ' bytes)' });
                    captureCount[0]++;
                }
            });
            send({ type: 'info', message: 'Blend hook OK' });
        } catch (e) { send({ type: 'error', message: 'Blend hook: ' + e }); }
    }

    send({ type: 'info', message: 'Waiting for reads... browse the game.' });

    var ticks = [0];
    var timer = setInterval(function () {
        ticks[0]++;
        if (ticks[0] >= 60) {
            clearInterval(timer);
            send({ type: 'info', message: 'Timeout.' });
            send({ type: 'done' });
        }
    }, 10000);

    recv('stop', function () {
        clearInterval(timer);
        send({ type: 'done' });
    });
}
