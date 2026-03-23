// Star Savior - Check available Frida APIs and enumerate modules
'use strict';

setTimeout(() => {
    console.log('=== Star Savior - Frida Environment Check ===');
    console.log('');
    
    // Check available APIs
    console.log('Java.available: ' + (typeof Java !== 'undefined' && Java.available));
    console.log('ObjC.available: ' + (typeof ObjC !== 'undefined' && ObjC.available));
    console.log('Il2Cpp: ' + (typeof Il2Cpp !== 'undefined'));
    console.log('Mono: ' + (typeof Mono !== 'undefined'));
    console.log('Process.enumerateModules: ' + typeof Process.enumerateModules);
    
    // List loaded modules
    console.log('');
    console.log('=== Loaded Modules ===');
    const modules = Process.enumerateModules();
    for (const mod of modules) {
        const name = mod.name || mod.path || '?';
        if (name.toLowerCase().includes('star') || 
            name.toLowerCase().includes('nkc') ||
            name.toLowerCase().includes('nkm') ||
            name.toLowerCase().includes('mono') ||
            name.toLowerCase().includes('il2cpp') ||
            name.toLowerCase().includes('unity') ||
            name.toLowerCase().includes('game') ||
            name.toLowerCase().includes('assembly')) {
            console.log('  ' + name + ' @ ' + mod.base + ' (size: ' + mod.size + ')');
        }
    }
    
    // Try to find the game's scripting backend
    console.log('');
    console.log('=== Checking ObjC classes ===');
    if (ObjC.available) {
        try {
            const classes = ObjC.classes;
            console.log('ObjC.classes available, count: ' + Object.keys(classes).length);
            
            // Search for equip-related classes
            for (const name of Object.keys(classes)) {
                if (name.includes('Equip') || name.includes('Tooltip') || name.includes('Item')) {
                    console.log('  ObjC: ' + name);
                }
            }
        } catch(e) {
            console.log('ObjC error: ' + e);
        }
    }
    
    // Check if we can use Process.findModuleByName
    console.log('');
    console.log('=== Module lookup ===');
    const names = ['GameAssembly.dll', 'Assembly-CSharp.dll', 'StarSavior.exe', 'mono.dll', 'mono-2.0-unity.dll'];
    for (const name of names) {
        const mod = Process.findModuleByName(name);
        console.log('  findModuleByName("' + name + '"): ' + (mod ? mod.name + ' @ ' + mod.base : 'NOT FOUND'));
    }
    
}, 500);
