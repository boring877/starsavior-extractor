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
var cis = NF('mono_class_instance_size', 'int', ['pointer']);

var img = NF('mono_image_open', 'pointer', ['pointer', 'int', 'int']);
var aam = NF('mono_array_new_full', 'pointer', ['pointer', 'int', 'pointer', 'pointer', 'pointer']);
var gdf = NF('mono_field_desc_get_type', 'pointer', ['pointer']);
var mfv = NF('mono_field_desc_get_name', 'pointer', ['pointer']);

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

function hexStr(ptr, len) {
    if (!ptr || ptr.isNull()) return '<null>';
    var parts = [];
    for (var i = 0; i < Math.min(len, 128); i++) {
        parts.push(('0' + ptr.add(i).readU8().toString(16)).slice(-2));
    }
    return parts.join(' ');
}

send({ type: 'info', message: '=== Direct Read Invocation ===' });

var blendObjs = [];
var blendClass = null;
var xorObj = null;

var cb = new NativeCallback(function (t, u) {
    if (!t || t.isNull()) return;
    try {
        var k = ogc(t);
        if (!k || k.isNull()) return;
        var n = cnFn(k).readUtf8String();
        if (n === 'PartialBitBlendReadStream') {
            if (!blendClass) blendClass = k;
            blendObjs.push(t);
        }
        if (n === 'PartialXorProcessStream') {
            xorObj = t;
        }
    } catch (e) {}
}, 'void', ['pointer', 'pointer']);

hf(cb, ptr(0));
send({ type: 'info', message: 'Found ' + blendObjs.length + ' BlendStream, XOR stream: ' + (xorObj ? 'yes' : 'no') });

if (!blendClass || blendObjs.length === 0) {
    send({ type: 'error', message: 'No blend streams found' });
    send({ type: 'done' });
}

// Enumerate methods on PartialBitBlendReadStream
send({ type: 'info', message: 'Enumerating PartialBitBlendReadStream methods...' });
var readMethod = findMethod(blendClass, 'Read', 3);
send({ type: 'info', message: 'Read method: ' + (readMethod ? 'found' : 'NOT FOUND') });

// List all methods
var allMethods = [];
var c = blendClass;
var safety = 0;
while (c && !c.isNull() && safety < 200) {
    try {
        var iter = Memory.alloc(16);
        iter.writeU64(0);
        var m = mfn(c, ptr(0), 0);
        var mc = 0;
        // mono_class_get_methods needs to be called differently
        // Let's just list what we found via findMethod
    } catch (e) {}
    safety++;
}

// Try common method names to understand the class
var methodNames = ['Read', 'Write', 'Seek', 'SetLength', 'Flush', 'Close', 'Dispose',
    'get_CanRead', 'get_CanSeek', 'get_Position', 'get_Length',
    'get_KeyData', 'get_Position', 'get_EncryptionType', 'get_Transform',
    'BeginRead', 'EndRead', 'GetKey', 'Init'];
for (var i = 0; i < methodNames.length; i++) {
    var m = findMethod(blendClass, methodNames[i], -1);
    if (m) send({ type: 'info', message: '  ' + methodNames[i] + '(' + (methodNames[i] === 'Read' ? 3 : -1) + ')' });
}

// Dump raw memory of first blend object
var firstBlend = blendObjs[0];
var objSize = cis(blendClass);
send({ type: 'info', message: 'Blend object size: ' + objSize + ' bytes' });
send({ type: 'info', message: 'Raw dump: ' + hexStr(firstBlend, objSize) });

// Dump first XOR object
if (xorObj) {
    var xorSize = cis(ogc(xorObj));
    send({ type: 'info', message: 'XOR object size: ' + xorSize + ' bytes' });
    send({ type: 'info', message: 'Raw dump: ' + hexStr(xorObj, xorSize) });
}

// Now try to create a managed byte array and call Read directly
var byteClass = ogc(aam(rootDomain, 2, 4096, ptr(0)));
send({ type: 'info', message: 'Byte[] class: ' + (byteClass ? cnFn(byteClass).readUtf8String() : 'FAILED') });

if (!byteClass || byteClass.isNull()) {
    send({ type: 'error', message: 'Could not create byte array class' });
    send({ type: 'done' });
}

// Try to allocate a managed array
var byteArrObj = aam(rootDomain, byteClass, 4096, ptr(0), ptr(0), ptr(0));
send({ type: 'info', message: 'Array alloc: ' + (byteArrObj && !byteArrObj.isNull() ? 'OK' : 'FAILED') });

if (byteArrObj && !byteArrObj.isNull()) {
    // Call Read(byte[], int, int) on the first blend stream
    // Parameters: obj, method, params, exc
    // params needs to be: [byte[] arr, int offset, int count]
    
    var paramArr = aam(rootDomain, byteClass, 3, byteArrObj, ptr(0), ptr(0));
    send({ type: 'info', message: 'Params array: ' + (paramArr && !paramArr.isNull() ? 'OK' : 'FAILED') });

    if (paramArr && !paramArr.isNull()) {
        // Fill params: arr at [0], offset at [8], count at [16] (LE layout on MonoArray of objects)
        try {
            paramArr.add(24).writePointer(byteArrObj);
            var exc = Memory.alloc(8);
            exc.writePointer(ptr(0));
            send({ type: 'info', message: 'Calling Read on blend stream...' });
            var result = ri(readMethod, firstBlend, paramArr, exc);
            var retVal = result && !result.isNull() ? result.add(16).readS32() : -1;
            send({ type: 'info', message: 'Read returned: ' + retVal + ' bytes' });
            
            // Read the array data
            var arrLen = byteArrObj.add(16).readU32();
            var arrData = byteArrObj.add(24).readPointer();
            send({ type: 'info', message: 'Array data: ' + hexStr(arrData, Math.min(retVal, 128)) });
        } catch (e) {
            send({ type: 'error', message: 'Read invocation failed: ' + e });
        }
    }
}

send({ type: 'done' });
