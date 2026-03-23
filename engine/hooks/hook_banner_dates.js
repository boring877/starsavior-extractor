'use strict';

// Frida hook to extract banner dates from Star Savior's GachaScheduleData and BannerSlotInfo
// Targets: GachaScheduleData (server-side gacha schedule with start/end times)
//          BannerSlotInfo (links banner templets to interval times)
//          IntervalTime (DateTime range object with StartTime/EndTime)

var mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
var NF = function(n, r, a) { return new NativeFunction(mono.getExportByName(n), r, a); };
var getRootDomain = NF('mono_get_root_domain', 'pointer', []);
var jitAttach = NF('mono_jit_thread_attach', 'pointer', ['pointer']);
var ogc = NF('mono_object_get_class', 'pointer', ['pointer']);
var cnFn = NF('mono_class_get_name', 'pointer', ['pointer']);
var cns = NF('mono_class_get_namespace', 'pointer', ['pointer']);
var cp = NF('mono_class_get_parent', 'pointer', ['pointer']);
var hf = NF('mono_unity_gc_handles_foreach_get_target', 'void', ['pointer', 'pointer']);
var gf = NF('mono_class_get_fields', 'pointer', ['pointer', 'pointer']);
var gnf = NF('mono_field_get_name', 'pointer', ['pointer']);
var gft = NF('mono_field_get_type', 'pointer', ['pointer']);
var tfn = NF('mono_type_get_name', 'pointer', ['pointer']);
var getFieldOffset = NF('mono_field_get_offset', 'int', ['pointer', 'pointer']);
var readArrLen = NF('mono_array_length', 'int', ['pointer']);
var readArrAddr = NF('mono_array_addr_with_size', 'pointer', ['pointer', 'int', 'int']);

var rootDomain = getRootDomain();
jitAttach(rootDomain);

function readMonoStr(o) {
    if (!o || o.isNull()) return null;
    try { var l = o.add(16).readS32(); if (l > 0 && l < 10000000) return o.add(20).readUtf16String(l); } catch (e) {}
    return null;
}

function getFields(klass) {
    var iter = Memory.alloc(8);
    iter.writePointer(ptr(0));
    var fields = [];
    while (true) {
        var f = gf(klass, iter);
        if (!f || f.isNull()) break;
        fields.push(f);
    }
    return fields;
}

// DateTime in Mono is stored as ticks (Int64, 8 bytes) at offset 0
// Ticks since 0001-01-01 00:00:00, where 1 tick = 100ns
// DateTime.UnixEpoch = 621355968000000000 ticks
var UNIX_EPOCH_TICKS = 621355968000000000n;
var TICKS_PER_MS = 10000n;

function readDateTime(obj, offset) {
    try {
        var ticks = obj.add(offset).readU64();
        if (ticks > UNIX_EPOCH_TICKS) {
            var ms = (ticks - UNIX_EPOCH_TICKS) / TICKS_PER_MS;
            var d = new Date(Number(ms));
            return d.toISOString();
        }
    } catch (e) {}
    return null;
}

// Obfuscated class names from decompiled DLLs
var GACHA_SCHEDULE_CLASS = '\u0D4A\u0D05\u0D07\u0D09\u0D0A\u0D05\u0DCC\u0D09\u0D06\u0D43\u0D05\u0D07\u0D05\u0DCC\u0D33\u0D08';
var BANNER_SLOT_CLASS = '\u0D07\u0D0B\u0D07\u0D07\u0D0A\u0DCC\u0DCC\u0D06\u0DCC\u0DCC\u0D33\u0DCC\u0D33\u0D48\u0D48\u0D09\u0DCC\u0D33\u0D48';
var BANNER_TEMPLET_CLASS = '\u0D06\u0D4A\u0DCC\u0D09\u0D08\u0D48\u0D48\u0D09\u0D0B\u0DCC\u0D09\u0D07\u0D09\u0D0A\u0DCC\u0D08';
var INTERVAL_TIME_CLASS = '\u0D4C\u0D4C\u0D07\u0D0B\u0D08\u0D0A\u0D48\u0D08\u0D48\u0D48\u0D08\u0D06\u0D4A\u0D4B\u0D05\u0D4A\u0D4B';
var BANNER_MANAGER_CLASS = '\u0D08\u0D07\u0D07\u0D09\u0D06\u0D08\u0D05\u0D09\u0D06\u0D08\u0D48\u0D08\u0DCC\u0DCC\u0D0B\u0D4B\u0DCC';

// Known field names from decompiled code
var GACHA_SCHEDULE_FIELDS = {
    scheduleId: '\u0D07\u0D07\u0D05\u0D08\u0DCC\u0D06\u0D07\u0D09\u0D0B\u0D48\u0D08\u0D48\u0D0A\u0D48\u0DCC\u0DCC',
    interval: '\u0D06\u0D4A\u0DCC\u0D0A\u0D4A\u0D06\u0D08\u0D4B\u0D4C\u0D0A\u0D0A\u0D48\u0DCC\u0D4A\u0D48\u0DCC\u0D0A\u0D4A\u0D49\u0D05\u0D4A\u0D08',
    newbieInterval: '\u0D4A\u0D06\u0D06\u0D06\u0D07\u0D09\u0D0B\u0D0A\u0D48\u0D0A\u0D4B\u0D0B\u0D07\u0D05\u0D4A\u0D08\u0D48\u0D48\u0D09',
    scheduleType: '\u0D05\u0D08\u0D05\u0D05\u0D4A\u0D4B\u0D08\u0D48\u0D0A\u0D48\u0D07\u0D0A\u0D48\u0D0A\u0D46\u0D06\u0D46\u0D4A\u0D4A',
    nameKey: '\u0D08\u0D4A\u0D4A\u0D09\u0D07\u0D0A\u0D48\u0D06\u0DCC\u0D08\u0D0B\u0D0A\u0D48\u0D0A\u0D0B\u0D0A\u0D0D',
    missionCount: '\u0D07\u0D07\u0D4A\u0DCC\u0D0B\u0D46\u0D06\u0D48\u0D48\u0D0B\u0DCC\u0DCC\u0D4C\u0D06\u0DCC\u0D33\u0D4C',
};

var BANNER_SLOT_FIELDS = {
    templet: '\u0D06\u0D47\u0D05\u0D07\u0D08\u0D07\u0D48\u0D48\u0D05\u0D4B\u0D4B\u0D06\u0D4B\u0D49\u0D0B\u0D49\u0D07\u0D0A',
    interval: '\u0D06\u0D4A\u0DCC\u0D0A\u0D4A\u0D06\u0D08\u0D4B\u0D4C\u0D0A\u0D0A\u0D48\u0DCC\u0D4A\u0D48\u0DCC\u0D0A\u0D4A\u0D49\u0D05\u0D4A\u0D08',
    tabResource: '\u0D06\u0DCC\u0D09\u0D09\u0D48\u0D07\u0D06\u0D48\u0D08\u0D0A\u0D46\u0D46\u0D05\u0D4B',
    bannerNameKey: '\u0D08\u0D48\u0D07\u0D05\u0D07\u0D08\u0D07\u0D48\u0D08\u0D48\u0D0A\u0D46\u0D06\u0D48\u0D0B\u0D46',
    isNewbieOnly: '\u0D05\u0DCC\u0D0B\u0D49\u0D09\u0D0B\u0D0C\u0D48\u0D08\u0D0B\u0D0C\u0D05\u0D4B\u0D49\u0D07\u0D05',
    isTimeGated: '\u0D06\u0D06\u0D05\u0DCC\u0D48\u0DCC\u0D09\u0D0B\u0D0B\u0D0B\u0D05\u0D4B\u0D47\u0D07\u0D06\u0D09',
};

var BANNER_TEMPLET_FIELDS = {
    bannerId: '\u0D06\u0D07\u0D07\u0D07\u0D0B\u0D0C\u0D07\u0D08',
    bannerType: '\u0D06\u0D4A\u0D0A\u0D07\u0D0C\u0D48\u0D08\u0D0A\u0D48\u0D0A\u0D48',
    intervalId: '\u0D08\u0D4C\u0D06\u0D48\u0D05\u0D07\u0D0A\u0D48\u0D06\u0DCC\u0D08\u0D49\u0D06\u0DCC\u0D08\u0D0C\u0D48\u0D08',
    bannerTypeValue: '\u0D06\u0D47\u0D09\u0DCC\u0D0C\u0D09\u0D4A\u0D0B\u0D06\u0D49\u0D0B\u0D48\u0D08\u0D0A\u0D48\u0D0A\u0D48',
    bannerName: '\u0D06\u0D07\u0D07\u0D28\u0D07\u0D0B\u0D28\u0D48\u0D2E\u0D07',
    bannerThumbnail: '\u0D06\u0D07\u0D07\u0D28\u0D07\u0D0B\u0D28\u0D48\u0D2E\u0D40\u0D28\u0D48\u0D2F\u0D32\u0D4D',
    isPriority: '\u0D08\u0D38\u0D2A\u0D4D\u0D30\u0D3F\u0D2F\u0D4B\u0D30\u0D3F\u0D1F\u0D4D\u0D1F\u0D3F',
    bannerSort: '\u0D06\u0D47\u0D07\u0D28\u0D4D\u0D28\u0D47\u0D7C\u0D38\u0D4B\u0D7C\u0D1F\u0D4D',
    shortcutType1: '\u0D37\u0D4B\u0D7C\u0D1F\u0D4D\u0D15\u0D1F\u0D4D\u0D1F\u0D48\u0D2A\u0D4D\u0D2A\u0D4D \u0D1F\u0D48\u0D2A\u0D4D\u0D2A\u0D4D 1',
    contentsTag: '\u0D15\u0D23\u0D4D\u0D1F\u0D28\u0D4D\u0D31\u0D4D\u0D38\u0D4D \u0D1F\u0D3E\u0D17\u0D4D',
};

// Phase 1: Find IntervalTime class and its DateTime fields by scanning GC heap
// We look for objects that have exactly 2 DateTime fields (StartTime, EndTime)
// and are referenced by GachaScheduleData or BannerSlotInfo

function findIntervalTimeClass() {
    var candidates = {};
    var dateTimeOffsets = {};

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (!candidates[n]) candidates[n] = 0;
            candidates[n]++;
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return candidates;
}

// Phase 2: Scan for GachaScheduleData instances and extract their data
function scanGachaSchedules() {
    var found = [];
    var seen = {};

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (n !== GACHA_SCHEDULE_CLASS) return;

            // Avoid duplicates
            var addr = t.toString();
            if (seen[addr]) return;
            seen[addr] = true;

            var fields = getFields(k);
            var data = { className: n };

            for (var i = 0; i < fields.length; i++) {
                var fname = gnf(fields[i]).readUtf8String();
                var ft = gft(fields[i]);
                if (!ft || ft.isNull()) continue;
                var typeName = tfn(ft).readUtf8String();
                var offset = getFieldOffset(fields[i]);
                if (offset < 0 || offset > 100000) continue;

                if (typeName === 'System.Int32') {
                    data[fname] = t.add(offset).readS32();
                } else if (typeName === 'System.String') {
                    var strPtr = t.add(offset).readPointer();
                    var sv = readMonoStr(strPtr);
                    if (sv) data[fname] = sv.substring(0, 200);
                } else if (typeName === 'System.Boolean') {
                    data[fname] = t.add(offset).readU8() !== 0;
                } else {
                    // Reference type - could be IntervalTime, List, enum, etc.
                    var refPtr = t.add(offset).readPointer();
                    if (refPtr && !refPtr.isNull()) {
                        var refClass = ogc(refPtr);
                        if (refClass && !refClass.isNull()) {
                            var refName = cnFn(refClass).readUtf8String();
                            data[fname + '_class'] = refName;

                            // If this is the IntervalTime, try to read its DateTime fields
                            if (refName === INTERVAL_TIME_CLASS) {
                                var intervalData = readIntervalTime(refPtr);
                                if (intervalData) {
                                    data.interval_start = intervalData.startTime;
                                    data.interval_end = intervalData.endTime;
                                }
                            }
                        }
                    }
                }
            }

            found.push(data);
        } catch (e) {
            send({ type: 'error', msg: 'scanGachaSchedules: ' + e });
        }
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return found;
}

// Read IntervalTime fields - it has StartTime and EndTime as DateTime
function readIntervalTime(obj) {
    var fields = getFields(ogc(obj));
    var result = {};

    for (var i = 0; i < fields.length; i++) {
        var fname = gnf(fields[i]).readUtf8String();
        var ft = gft(fields[i]);
        if (!ft || ft.isNull()) continue;
        var typeName = tfn(ft).readUtf8String();
        var offset = getFieldOffset(fields[i]);
        if (offset < 0 || offset > 100000) continue;

        if (typeName === 'System.DateTime') {
            var dt = readDateTime(obj, offset);
            if (dt) {
                // Map obfuscated field names
                if (fname === '\u0D05\u0DCC\u0D05\u0D07\u0D08\u0D06\u0DCC\u0D4C\u0D48\u0D08\u0D0A\u0D48\u0DCC\u0D06\u0D47\u0D07\u0D33\u0D06\u0D48') {
                    result.startTime = dt;
                } else if (fname === '\u0D4C\u0D47\u0D47\u0D08\u0D06\u0D46\u0D06\u0D05\u0DCC\u0D4C\u0D4B\u0D4B\u0D0C\u0D48\u0D48\u0D0A\u0D48\u0D05\u0D49') {
                    result.endTime = dt;
                } else {
                    result[fname] = dt;
                }
            }
        } else if (typeName === 'System.String') {
            var strPtr = obj.add(offset).readPointer();
            var sv = readMonoStr(strPtr);
            if (sv) result[fname] = sv.substring(0, 200);
        } else if (typeName === 'System.Int32') {
            result[fname] = obj.add(offset).readS32();
        } else if (typeName === 'System.Boolean') {
            result[fname] = obj.add(offset).readU8() !== 0;
        }
    }

    return Object.keys(result).length > 0 ? result : null;
}

// Phase 3: Scan for BannerSlotInfo instances
function scanBannerSlots() {
    var found = [];
    var seen = {};

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (n !== BANNER_SLOT_CLASS) return;

            var addr = t.toString();
            if (seen[addr]) return;
            seen[addr] = true;

            var fields = getFields(k);
            var data = { className: n };

            for (var i = 0; i < fields.length; i++) {
                var fname = gnf(fields[i]).readUtf8String();
                var ft = gft(fields[i]);
                if (!ft || ft.isNull()) continue;
                var typeName = tfn(ft).readUtf8String();
                var offset = getFieldOffset(fields[i]);
                if (offset < 0 || offset > 100000) continue;

                if (typeName === 'System.String') {
                    var strPtr = t.add(offset).readPointer();
                    var sv = readMonoStr(strPtr);
                    if (sv) data[fname] = sv.substring(0, 200);
                } else if (typeName === 'System.Boolean') {
                    data[fname] = t.add(offset).readU8() !== 0;
                } else {
                    var refPtr = t.add(offset).readPointer();
                    if (refPtr && !refPtr.isNull()) {
                        var refClass = ogc(refPtr);
                        if (refClass && !refClass.isNull()) {
                            var refName = cnFn(refClass).readUtf8String();
                            data[fname + '_class'] = refName;

                            // If this is a BannerTemplet, read its key fields
                            if (refName === BANNER_TEMPLET_CLASS) {
                                var templetData = readBannerTemplet(refPtr);
                                if (templetData) {
                                    for (var key in templetData) {
                                        data['templet_' + key] = templetData[key];
                                    }
                                }
                            }
                            // If this is IntervalTime, read its dates
                            if (refName === INTERVAL_TIME_CLASS) {
                                var intervalData = readIntervalTime(refPtr);
                                if (intervalData) {
                                    data.interval_start = intervalData.startTime;
                                    data.interval_end = intervalData.endTime;
                                }
                            }
                        }
                    }
                }
            }

            found.push(data);
        } catch (e) {
            send({ type: 'error', msg: 'scanBannerSlots: ' + e });
        }
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return found;
}

// Read BannerTemplet key fields
function readBannerTemplet(obj) {
    var fields = getFields(ogc(obj));
    var result = {};

    for (var i = 0; i < fields.length; i++) {
        var fname = gnf(fields[i]).readUtf8String();
        var ft = gft(fields[i]);
        if (!ft || ft.isNull()) continue;
        var typeName = tfn(ft).readUtf8String();
        var offset = getFieldOffset(fields[i]);
        if (offset < 0 || offset > 100000) continue;

        if (typeName === 'System.String') {
            var strPtr = obj.add(offset).readPointer();
            var sv = readMonoStr(strPtr);
            if (sv) result[fname] = sv.substring(0, 200);
        } else if (typeName === 'System.Int32') {
            result[fname] = obj.add(offset).readS32();
        } else if (typeName === 'System.Boolean') {
            result[fname] = obj.add(offset).readU8() !== 0;
        }
    }

    return Object.keys(result).length > 0 ? result : null;
}

// Phase 4: Also scan for BannerManager singleton to get all active banners
function scanBannerManager() {
    var found = [];

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;
            var n = cnFn(k).readUtf8String();
            if (n !== BANNER_MANAGER_CLASS) return;

            var fields = getFields(k);
            var data = { className: n };

            for (var i = 0; i < fields.length; i++) {
                var fname = gnf(fields[i]).readUtf8String();
                var ft = gft(fields[i]);
                if (!ft || ft.isNull()) continue;
                var typeName = tfn(ft).readUtf8String();
                var offset = getFieldOffset(fields[i]);
                if (offset < 0 || offset > 100000) continue;

                if (typeName === 'System.DateTime') {
                    var dt = readDateTime(t, offset);
                    if (dt) data[fname] = dt;
                } else {
                    var refPtr = t.add(offset).readPointer();
                    if (refPtr && !refPtr.isNull()) {
                        var refClass = ogc(refPtr);
                        if (refClass && !refClass.isNull()) {
                            var refName = cnFn(refClass).readUtf8String();
                            // Look for List<BannerSlotInfo>
                            if (refName === 'List`1') {
                                var len = readArrLen(refPtr);
                                data[fname + '_List_len'] = len;
                                if (len > 0 && len < 100) {
                                    // Read first element to verify type
                                    var elemPtr = readArrAddr(refPtr, 0, Process.pointerSize);
                                    if (elemPtr && !elemPtr.isNull()) {
                                        var elem = elemPtr.readPointer();
                                        if (elem && !elem.isNull()) {
                                            var elemClass = ogc(elem);
                                            if (elemClass && !elemClass.isNull()) {
                                                data[fname + '_List_elemClass'] = cnFn(elemClass).readUtf8String();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            found.push(data);
        } catch (e) {
            send({ type: 'error', msg: 'scanBannerManager: ' + e });
        }
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return found;
}

// Phase 5: Discovery scan - find all classes that reference IntervalTime
// to understand the full data model
function discoverIntervalTimeUsers() {
    var intervalTimeUsers = {};
    var seen = {};

    var cb = new NativeCallback(function (t, u) {
        if (!t || t.isNull()) return;
        try {
            var k = ogc(t);
            if (!k || k.isNull()) return;

            var fields = getFields(k);
            for (var i = 0; i < fields.length; i++) {
                var ft = gft(fields[i]);
                if (!ft || ft.isNull()) continue;
                var typeName = tfn(ft).readUtf8String();
                if (typeName !== INTERVAL_TIME_CLASS) continue;

                var offset = getFieldOffset(fields[i]);
                if (offset < 0 || offset > 100000) continue;
                var refPtr = t.add(offset).readPointer();
                if (!refPtr || refPtr.isNull()) continue;

                var refClass = ogc(refPtr);
                if (!refClass || refClass.isNull()) continue;
                var refName = cnFn(refClass).readUtf8String();
                if (refName !== INTERVAL_TIME_CLASS) continue;

                var n = cnFn(k).readUtf8String();
                var ns = cns(k).readUtf8String();
                var key = ns + '.' + n;
                if (!seen[key]) {
                    seen[key] = true;
                    if (!intervalTimeUsers[key]) intervalTimeUsers[key] = [];
                    intervalTimeUsers[key].push(gnf(fields[i]).readUtf8String());
                }
            }
        } catch (e) {}
    }, 'void', ['pointer', 'pointer']);

    hf(cb, ptr(0));
    return intervalTimeUsers;
}

// Main execution
setTimeout(function() {
    send({ type: 'status', msg: 'Phase 1: Discovering IntervalTime field users...' });
    var users = discoverIntervalTimeUsers();
    send({ type: 'interval_users', count: Object.keys(users).length, users: users });

    send({ type: 'status', msg: 'Phase 2: Scanning GachaScheduleData instances...' });
    var schedules = scanGachaSchedules();
    send({ type: 'gacha_schedules', count: schedules.length, results: schedules });

    send({ type: 'status', msg: 'Phase 3: Scanning BannerSlotInfo instances...' });
    var slots = scanBannerSlots();
    send({ type: 'banner_slots', count: slots.length, results: slots });

    send({ type: 'status', msg: 'Phase 4: Scanning BannerManager singleton...' });
    var managers = scanBannerManager();
    send({ type: 'banner_manager', count: managers.length, results: managers });

    send({ type: 'done', msg: 'All scans complete.' });
}, 3000);
