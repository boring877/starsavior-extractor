var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var fn = new NativeFunction(mono.getExportByName('mono_get_root_domain'), 'pointer', []);
send('domain: ' + fn());

send('step 1');
var m = Memory.alloc(16);
send('step 2 mem: ' + m);

send('step 3');
Memory.writeU8(m, 0);
send('step 4');

var jit = new NativeFunction(mono.getExportByName('mono_jit_thread_attach'), 'pointer', ['pointer']);
send('step 5 jit: ' + jit);

var t = jit(m);
send('step 6 thread: ' + t);

var ri = new NativeFunction(mono.getExportByName('mono_runtime_invoke'), 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
send('step 7 ri: ' + ri);

var exc = Memory.alloc(8);
Memory.writePointer(exc, ptr(0));
send('step 8');

try {
    var r = ri(ptr(0), ptr(0), ptr(0), exc);
    send('step 9 result: ' + r);
} catch(e) {
    send('step 9 err: ' + e);
}
send('DONE');
