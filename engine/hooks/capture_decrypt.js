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
var cm = NF('mono_compile_method', 'pointer', ['pointer']);
var gffn = NF('mono_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
var gfo = NF('mono_field_get_offset', 'int', ['pointer']);
var cf = NF('mono_class_get_fields', 'pointer', ['pointer', 'pointer']);
var ffn = NF('mono_field_get_name', 'pointer', ['pointer']);
var fot = NF('mono_field_get_offset', 'int', ['pointer']);
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

function hexStr(buf, len) {
    var parts = [];
    for (var i = 0; i < Math.min(len, 64); i++) {
        parts.push(('0' + buf.add(i).readU8().toString(16)).slice(-2));
    }
    return parts.join(' ');
}

var OUTPUT_DIR = null;

send({ type: 'info', message: '=== Bundle Decryption Capture ===' });

var blendStreamClass = null;
var baseStreamOffset = -1;
var strategyOffset = -1;
var readHookActive = false;
var streamStates = {};
var streamCounter = 0;
var totalCaptured = 0;

function scanForClass() {
    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (n === 'PartialBitBlendReadStream' && !blendStreamClass) {
                blendStreamClass = k;
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);
    hf(cb, ptr(0));
}

scanForClass();

if (!blendStreamClass) {
    send({ type: 'info', message: 'PartialBitBlendReadStream not found yet - will retry every 3s (browse the game to load bundles)' });
    var retryCount = 0;
    var retryTimer = setInterval(function () {
        retryCount++;
        scanForClass();
        if (blendStreamClass) {
            clearInterval(retryTimer);
            send({ type: 'info', message: 'Found PartialBitBlendReadStream after ' + (retryCount * 3) + 's' });
            setupHook();
        }
        if (retryCount >= 30) {
            clearInterval(retryTimer);
            send({ type: 'error', message: 'Timeout waiting for PartialBitBlendReadStream - start browsing the game first' });
            send({ type: 'done' });
        }
    }, 3000);
} else {
    send({ type: 'info', message: 'Found PartialBitBlendReadStream (size: ' + cis(blendStreamClass) + ')' });
    setupHook();
}

function setupHook() {
    try {
        var bsField = gffn(blendStreamClass, Memory.allocUtf8String('baseStream'));
        if (bsField && !bsField.isNull()) {
            baseStreamOffset = gfo(bsField);
            send({ type: 'info', message: 'baseStream offset: ' + baseStreamOffset });
        }
    } catch (e) {
        send({ type: 'info', message: 'baseStream field not found: ' + e });
    }

    try {
        var stratField = gffn(blendStreamClass, Memory.allocUtf8String('strategy'));
        if (stratField && !stratField.isNull()) {
            strategyOffset = gfo(stratField);
            send({ type: 'info', message: 'strategy offset: ' + strategyOffset });
        }
    } catch (e) {
        send({ type: 'info', message: 'strategy field not found: ' + e });
    }

    var readMethod = findMethod(blendStreamClass, 'Read', 3);
    if (!readMethod) {
        send({ type: 'error', message: 'Read method not found' });
        send({ type: 'done' });
        return;
    }

    var nativeAddr = cm(readMethod);
    if (!nativeAddr || nativeAddr.isNull()) {
        send({ type: 'error', message: 'Failed to compile Read method' });
        send({ type: 'done' });
        return;
    }

    send({ type: 'info', message: 'Read compiled: ' + nativeAddr });

    var ARRAY_DATA_OFFSET = null;
    var probeCount = 0;

    function probeArrayLayout(bufPtr, offset, count) {
        var probes = {};
        for (var off = 16; off <= 32; off += 4) {
            try {
                var val = bufPtr.add(off).readU32();
                probes['u32@' + off] = val;
            } catch (e) {}
            try {
                var ptr = bufPtr.add(off).readPointer();
                probes['ptr@' + off] = ptr.toString();
            } catch (e) {}
        }
        try {
            probes['len@16'] = bufPtr.add(16).readU32();
        } catch (e) {}
        send({ type: 'probe', buf: bufPtr.toString(), offset: offset, count: count, fields: probes });
    }

    Interceptor.attach(nativeAddr, {
        onEnter: function (args) {
            this.self = args[0];
            this.buf = args[1];
            this.offset = args[2].toInt32();
            this.count = args[3].toInt32();
        },
        onLeave: function (retval) {
            var bytesRead = retval.toInt32();
            if (bytesRead <= 0) {
                var key = this.self.toString();
                var st = streamStates[key];
                if (st && !st.closed && st.bytesTotal > 0) {
                    finalizeStream(st);
                }
                return;
            }

            if (!OUTPUT_DIR) return;

            var key = this.self.toString();
            var state = streamStates[key];
            if (!state) {
                state = initStream(this.self);
                if (!state) return;
            }
            if (state.closed) return;

            try {
                if (ARRAY_DATA_OFFSET === null && probeCount < 5) {
                    probeCount++;
                    probeArrayLayout(this.buf, this.offset, bytesRead);

                    var lenAt16 = this.buf.add(16).readU32();
                    send({ type: 'info', message: 'Array len@16=' + lenAt16 + ' offset=' + this.offset + ' count=' + bytesRead });

                    var best = null;
                    var candidates = [20, 24];
                    for (var ci = 0; ci < candidates.length; ci++) {
                        try {
                            var probeAddr = this.buf.add(candidates[ci]);
                            var b0 = probeAddr.readU8();
                            var b1 = probeAddr.add(1).readU8();
                            var b2 = probeAddr.add(2).readU8();
                            var b3 = probeAddr.add(3).readU8();
                            var marker = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
                            send({ type: 'info', message: 'offset+' + candidates[ci] + ': ' + b0.toString(16) + ' ' + b1.toString(16) + ' ' + b2.toString(16) + ' ' + b3.toString(16) + ' (marker=0x' + marker.toString(16) + ')' });

                            if (marker === 0x556E6974) {
                                ARRAY_DATA_OFFSET = candidates[ci];
                                send({ type: 'info', message: 'FOUND UnityFS at offset ' + candidates[ci] + ' in buffer!' });
                                break;
                            }

                            if (!best && lenAt16 > 0 && lenAt16 < 100000000) {
                                best = candidates[ci];
                            }
                        } catch (e) {
                            send({ type: 'info', message: 'offset+' + candidates[ci] + ': FAILED - ' + e });
                        }
                    }

                    if (ARRAY_DATA_OFFSET === null && best) {
                        ARRAY_DATA_OFFSET = best;
                        send({ type: 'info', message: 'Using data offset ' + best + ' (len@16 looks valid)' });
                    }

                    if (ARRAY_DATA_OFFSET === null) {
                        ARRAY_DATA_OFFSET = 20;
                        send({ type: 'info', message: 'Falling back to data offset 20' });
                    }
                }

                var chunkStart = this.buf.add(ARRAY_DATA_OFFSET + this.offset);
                var chunk = chunkStart.readByteArray(bytesRead);
                if (!chunk) return;

                if (state.file) {
                    state.file.write(chunk);
                } else {
                    state.chunks.push(chunk);
                }

                state.bytesTotal += bytesRead;
                state.position += bytesRead;

                if (state.bytesTotal === bytesRead) {
                    state.headerHex = hexStr(chunkStart, Math.min(16, bytesRead));
                    send({ type: 'bundle_start', name: state.name, header: state.headerHex });
                }

                if (state.bytesTotal % (256 * 1024) < bytesRead) {
                    send({ type: 'progress', name: state.name, bytes: state.bytesTotal });
                }
            } catch (e) {
                if (!state.errorSent) {
                    send({ type: 'error', message: 'Capture error for ' + state.name + ': ' + e });
                    state.errorSent = true;
                }
            }
        }
    });

    readHookActive = true;
    send({ type: 'info', message: 'Hook active! Browse the game to trigger bundle loading.' });
    send({ type: 'ready' });
}

function getBundleName(streamPtr) {
    if (strategyOffset > 0) {
        try {
            var stratPtr = streamPtr.add(strategyOffset).readPointer();
            if (!stratPtr || stratPtr.isNull()) throw 'no strategy';

            var stratClass = ogc(stratPtr);
            if (!stratClass || stratClass.isNull()) throw 'no strat class';

            var stratClassName = cnFn(stratClass).readUtf8String();
            if (stratClassName !== 'FileNameMasking') throw 'not FileNameMasking: ' + stratClassName;

            var iter = Memory.alloc(Process.pointerSize);
            iter.writePointer(ptr(0));
            while (true) {
                var field = cf(stratClass, iter);
                if (!field || field.isNull()) break;
                var fnamePtr = ffn(field);
                if (!fnamePtr || fnamePtr.isNull()) continue;
                var fname = fnamePtr.readUtf8String();

                if (fname === 'fileName' || fname === '_fileName' || fname === '<fileName>k__BackingField') {
                    var foff = fot(field);
                    var strObjPtr = stratPtr.add(foff).readPointer();
                    var str = readMonoStr(strObjPtr);
                    if (str) return str;
                }
            }
        } catch (e) {
            send({ type: 'info', message: 'Strategy name lookup failed: ' + e });
        }
    }

    if (baseStreamOffset > 0) {
        try {
            var bsPtr = streamPtr.add(baseStreamOffset).readPointer();
            if (!bsPtr || bsPtr.isNull()) throw 'no baseStream';

            var bsClass = ogc(bsPtr);
            if (!bsClass || bsClass.isNull()) throw 'no bsClass';

            var nameObj = invoke(bsPtr, bsClass, 'get_Name', 0);
            if (nameObj && !nameObj.isNull()) {
                var name = readMonoStr(nameObj);
                if (name) return name;
            }

            var bsClassName = cnFn(bsClass).readUtf8String();
            var innerField = gffn(bsClass, Memory.allocUtf8String('_stream'));
            if (innerField && !innerField.isNull()) {
                var innerOffset = gfo(innerField);
                var innerPtr = bsPtr.add(innerOffset).readPointer();
                if (innerPtr && !innerPtr.isNull()) {
                    var innerClass = ogc(innerPtr);
                    if (innerClass && !innerClass.isNull()) {
                        var innerName = invoke(innerPtr, innerClass, 'get_Name', 0);
                        if (innerName && !innerName.isNull()) {
                            var n = readMonoStr(innerName);
                            if (n) return n;
                        }
                    }
                }
            }
        } catch (e) {
            send({ type: 'info', message: 'FileStream name lookup failed: ' + e });
        }
    }

    return null;
}

function initStream(streamPtr) {
    var key = streamPtr.toString();
    if (streamStates[key]) return streamStates[key];

    var bundleName = getBundleName(streamPtr);
    var fileName;

    if (bundleName) {
        var clean = bundleName.replace(/\\/g, '/').split('/').pop();
        fileName = clean.replace('.bundle', '') + '.decrypted';
    } else {
        streamCounter++;
        fileName = 'unknown_' + streamCounter + '.decrypted';
    }

    var filePath = OUTPUT_DIR + '/' + fileName;
    var file = null;

    try {
        file = new File(filePath, 'wb');
    } catch (e) {
        send({ type: 'error', message: 'Cannot create file ' + filePath + ': ' + e });
    }

    var state = {
        name: fileName,
        file: file,
        path: filePath,
        position: 0,
        bytesTotal: 0,
        headerHex: null,
        closed: false,
        chunks: [],
        errorSent: false
    };
    streamStates[key] = state;

    send({ type: 'bundle_open', name: fileName, originalName: bundleName || 'unknown', path: filePath });
    return state;
}

function finalizeStream(state) {
    if (state.closed) return;
    state.closed = true;

    if (state.file) {
        try {
            state.file.flush();
            state.file.close();
        } catch (e) {}
    }

    totalCaptured++;

    var isValid = state.headerHex && state.headerHex.startsWith('55 6e 69 74 79 46 53');
    send({
        type: 'bundle_done',
        name: state.name,
        bytes: state.bytesTotal,
        validUnityFS: isValid,
        header: state.headerHex
    });

    cleanupOldStreams();
}

function cleanupOldStreams() {
    var keys = Object.keys(streamStates);
    if (keys.length > 20) {
        var toRemove = keys.filter(function (k) { return streamStates[k].closed; });
        for (var i = 0; i < toRemove.length; i++) {
            delete streamStates[toRemove[i]];
        }
    }
}

recv('set_output_dir', function (msg) {
    OUTPUT_DIR = msg.dir;
    send({ type: 'info', message: 'Output dir: ' + OUTPUT_DIR });
});

recv('finalize', function () {
    for (var key in streamStates) {
        var state = streamStates[key];
        if (!state.closed && state.bytesTotal > 0) {
            finalizeStream(state);
        }
    }
    send({ type: 'capture_complete', totalBundles: totalCaptured });
    send({ type: 'done' });
});

recv('status', function () {
    var active = 0;
    var done = 0;
    for (var key in streamStates) {
        if (streamStates[key].closed) done++;
        else active++;
    }
    send({ type: 'status', active: active, done: done, totalCaptured: totalCaptured });
});
