'use strict';

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };

var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var assemblyGetImage = NF('mono_assembly_get_image', 'pointer', ['pointer']);
var assemblyGetName = NF('mono_assembly_get_name', 'pointer', ['pointer']);
var assemblyNameGet = NF('mono_assembly_name_get_name', 'pointer', ['pointer']);
var domainAssemblyForeach = NF('mono_domain_assembly_foreach', 'void', ['pointer', 'pointer']);
var classFromName = NF('mono_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
var mfn = NF('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var cm = NF('mono_compile_method', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cnsFn = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var gffn = NF('mono_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
var gfo = NF('mono_field_get_offset', 'int', ['pointer']);
var ri = NF('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

function readMonoStr(o) {
    if (!o || o.isNull()) return null;
    try {
        var l = o.add(16).readS32();
        if (l > 0 && l < 10000000) return o.add(20).readUtf16String(l);
    } catch (e) {}
    return null;
}

function hexBuf(ptr, len) {
    var parts = [];
    for (var i = 0; i < len; i++) {
        parts.push(('0' + ptr.add(i).readU8().toString(16)).slice(-2));
    }
    return parts.join(' ');
}

send({ type: 'info', message: '=== BitBlend Filename Mask Scanner ===' });

var assemblyImages = {};

var asmCb = new NativeCallback(function (asm, userdata) {
    try {
        var name = assemblyNameGet(assemblyGetName(asm));
        if (name && !name.isNull()) {
            var nameStr = name.readUtf8String();
            var img = assemblyGetImage(asm);
            if (img && !img.isNull()) {
                assemblyImages[nameStr] = img;
            }
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);
domainAssemblyForeach(rootDomain, asmCb);
send({ type: 'info', message: 'Assemblies: ' + Object.keys(assemblyImages).length });

function findImage(name) {
    var img = assemblyImages[name];
    if (img) return img;
    for (var key in assemblyImages) {
        if (key.indexOf(name) >= 0) return assemblyImages[key];
    }
    return null;
}

var MAX_HOOK = 50;
var hookCount = 0;

function tryHook(image, ns, cls, method, pcount, label) {
    var klass = classFromName(image, Memory.allocUtf8String(ns), Memory.allocUtf8String(cls));
    if (!klass || klass.isNull()) {
        send({ type: 'info', message: label + ': class NOT FOUND' });
        return;
    }
    var m = mfn(klass, Memory.allocUtf8String(method), pcount);
    if (!m || m.isNull()) {
        send({ type: 'info', message: label + ': method NOT FOUND' });
        return;
    }
    var addr = cm(m);
    if (!addr || addr.isNull()) {
        send({ type: 'info', message: label + ': compile FAILED' });
        return;
    }
    send({ type: 'info', message: label + ': hooked at ' + addr });
    Interceptor.attach(addr, {
        onEnter: function (args) {
            if (hookCount >= MAX_HOOK) return;
            var idx = (label === 'ComputeMd5Hash') ? 0 : 1;
            var str = readMonoStr(args[idx]);
            if (!str && idx === 0) str = readMonoStr(args[1]);
            if (!str && idx === 1) str = readMonoStr(args[0]);
            if (str) {
                hookCount++;
                send({ type: 'filename', label: label, filename: str, count: hookCount });
            }
        }
    });
}

var csShareImg = findImage('Cs.UnityShare');
var urmImg = findImage('Unity.ResourceManager');

if (csShareImg) {
    tryHook(csShareImg, 'Cs.ByteToolkit.BitBlending.Strategies', 'FileNameMasking', '.ctor', 1, 'FileNameMasking_ctor');
    tryHook(csShareImg, 'Cs.ByteToolkit.BitBlending.Strategies', 'FileNameMasking', 'ComputeMd5Hash', 1, 'ComputeMd5Hash');
}
if (urmImg) {
    tryHook(urmImg, '', 'BundlePackType2', '.ctor', 1, 'BundlePackType2_ctor');
}

send({ type: 'info', message: 'Scanning GC heap...' });

var blendObjs = [];
var blendClass = null;
var scanCb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var n = cnFn(k).readUtf8String();
        if (n === 'PartialBitBlendReadStream') {
            if (!blendClass) blendClass = k;
            blendObjs.push(t);
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);
hf(scanCb, ptr(0));
send({ type: 'info', message: 'Found ' + blendObjs.length + ' PartialBitBlendReadStream' });

if (blendObjs.length > 0 && blendClass) {
    var stratField = gffn(blendClass, Memory.allocUtf8String('strategy'));
    var stratOff = stratField ? gfo(stratField) : -1;
    var bsField = gffn(blendClass, Memory.allocUtf8String('baseStream'));
    var bsOff = bsField ? gfo(bsField) : -1;
    var skipField = gffn(blendClass, Memory.allocUtf8String('skipBytes'));
    var skipOff = skipField ? gfo(skipField) : -1;
    send({ type: 'info', message: 'Fields: strategy=' + stratOff + ' baseStream=' + bsOff + ' skip=' + skipOff });

    var seen = {};
    for (var i = 0; i < blendObjs.length; i++) {
        var obj = blendObjs[i];
        try {
            var sp = obj.add(stratOff).readPointer();
            if (!sp || sp.isNull()) continue;
            var sc = ogc(sp);
            if (!sc || sc.isNull()) continue;
            if (cnFn(sc).readUtf8String() != 'FileNameMasking') continue;

            var mf = gffn(sc, Memory.allocUtf8String('maskBytes'));
            if (!mf || mf.isNull()) continue;
            var mo = gfo(mf);
            var ma = sp.add(mo).readPointer();
            if (!ma || ma.isNull()) continue;
            var ml = ma.add(24).readU32();
            if (ml != 16) continue;

            var mask = hexBuf(ma.add(32), 16);
            if (seen[mask]) continue;
            seen[mask] = true;

            var info = { index: i, maskBytes: mask };

            if (bsOff > 0) {
                var bp = obj.add(bsOff).readPointer();
                if (bp && !bp.isNull()) {
                    var bc = ogc(bp);
                    if (bc && !bc.isNull()) {
                        info.baseStreamClass = cnFn(bc).readUtf8String();
                        var gm = mfn(bc, Memory.allocUtf8String('get_Name'), 0);
                        if (gm && !gm.isNull()) {
                            var exc = Memory.alloc(8);
                            exc.writePointer(ptr(0));
                            var nr = ri(gm, bp, ptr(0), exc);
                            if (nr && !nr.isNull()) {
                                var ns = readMonoStr(nr);
                                if (ns) info.file = ns;
                            }
                        }
                    }
                }
            }

            if (skipOff > 0) {
                info.skip = obj.add(skipOff).readU64().toString();
            }

            send({ type: 'stream', data: info });
        } catch (e) {}
    }
    send({ type: 'info', message: 'Unique masks: ' + Object.keys(seen).length });
}

send({ type: 'ready' });

var ticks = 0;
var timer = setInterval(function () {
    ticks++;
    if (ticks >= 120) {
        clearInterval(timer);
        send({ type: 'done' });
    }
}, 1000);

recv('stop', function () {
    clearInterval(timer);
    send({ type: 'done' });
});
