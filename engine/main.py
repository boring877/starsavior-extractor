#!/usr/bin/env python3
import sys
import os
import argparse
import json
import time
import re
import frida

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.extractor import FridaExtractor, find_game_process, GAME_DATA_DIR, BUNDLE_DIR
from src.catalog_parser import CatalogParser
from src.bundle_decryptor import BundleDecryptor

DEFAULT_OUTPUT = r"D:\starsavior-extractor\output"
RESCAN_SECONDS = 10


def safe_filename(name, max_len=100):
    return re.sub(r'[<>:"/\\|?*]', "_", name)[:max_len]


def cmd_status(args):
    proc = find_game_process()
    if proc:
        print(f"Game is running: {proc}")
    else:
        print("Game is NOT running.")
    catalog_path = os.path.join(GAME_DATA_DIR, "StreamingAssets", "aa", "catalog.json")
    if os.path.exists(catalog_path):
        cat = CatalogParser(catalog_path).load()
        info = cat.summary()
        print(f"  Keys: {info['total_keys']}, Types: {info['resource_types']}")
        print(f"  Image keys: {len(cat.get_image_keys())}")


def cmd_extract(args):
    out = args.output
    for d in ["textures", "text_assets", "text_binary", "sprites"]:
        os.makedirs(os.path.join(out, d), exist_ok=True)

    ext = FridaExtractor(output_dir=out)
    if not ext.attach(args.process):
        sys.exit(1)
    if not ext.load_hooks():
        sys.exit(1)
    time.sleep(2)

    texture_data = []
    sprite_data = []
    ta_count = [0]
    bin_count = [0]
    total_scans = [0]
    last_scan_totals = {}
    stopping = [False]

    def save_results():
        with open(os.path.join(out, "textures", "_index.json"), "w") as f:
            json.dump(texture_data, f, indent=2, ensure_ascii=False)
        with open(os.path.join(out, "sprites", "_index.json"), "w") as f:
            json.dump(sprite_data, f, indent=2, ensure_ascii=False)

    def on_msg(msg, data):
        if msg["type"] != "send":
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "scan_done":
            scan = p.get("scan", 0)
            tex = p.get("Texture2D", 0)
            ta = p.get("TextAsset", 0)
            spr = p.get("Sprite", 0)
            new_tex = p.get("newTexture2D", 0)
            new_ta = p.get("newTextAsset", 0)
            new_spr = p.get("newSprite", 0)
            total_seen = p.get("totalSeen", 0)
            total_scans[0] = scan
            total = tex + ta + spr

            if scan == 1:
                print(f"Scan #{scan}: {tex} tex, {ta} ta, {spr} spr ({total} total)")
                print("Extracting initial batch...")
                ext.script.post({"type": "extract_all"})
                ext.script.post({"type": "start_auto"})
            else:
                new_total = new_tex + new_ta + new_spr
                if new_total > 0:
                    print(
                        f"Scan #{scan}: {new_total} NEW objects found ({total_seen} total) -- extracting..."
                    )
                    ext.script.post({"type": "extract_new"})
                else:
                    print(
                        f"Scan #{scan}: no new objects ({total_seen} total) -- browse the game to load more"
                    )

        elif t == "textures":
            texture_data.extend(p.get("data", []))

        elif t == "ta_text":
            ta_count[0] += 1
            name = p["name"]
            text = p.get("text", "")
            preview = text[:80].encode("ascii", errors="replace").decode("ascii")
            print(f"  [TXT] {name}: {preview}...")
            sf = safe_filename(name)
            file_ext = ".json" if text.strip()[:1] in "{[" else ".txt"
            with open(
                os.path.join(out, "text_assets", sf + file_ext),
                "w",
                encoding="utf-8",
                errors="replace",
            ) as f:
                f.write(text)

        elif t == "ta_bin" and data:
            bin_count[0] += 1
            name = p["name"]
            print(f"  [BIN] {name} ({len(data):,} bytes)")
            sf = safe_filename(name)
            file_ext = (
                ".skel"
                if "skel" in name.lower()
                else ".atlas"
                if "atlas" in name.lower()
                else ".bin"
            )
            with open(os.path.join(out, "text_binary", sf + file_ext), "wb") as f:
                f.write(data)

        elif t == "sprites":
            sprite_data.extend(p.get("data", []))

        elif t == "done":
            save_results()
            print(
                f"  Saved. Running totals: {len(texture_data)} tex, {ta_count[0]} ta, {bin_count[0]} bin, {len(sprite_data)} spr"
            )

        elif t == "info":
            msg = p.get("message", "")
            print(f"  [>] {msg}")

    ext.script.on("message", on_msg)

    print("Scanning Mono heap...")
    ext.script.post({"type": "scan"})

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass

    save_results()
    ext.script.post({"type": "stop_auto"})
    time.sleep(0.5)

    print(f"\nExtraction complete ({total_scans[0]} scans):")
    print(f"  Textures: {len(texture_data)}")
    print(f"  Text Assets: {ta_count[0]}")
    print(f"  Binary Assets: {bin_count[0]}")
    print(f"  Sprites: {len(sprite_data)}")
    print(f"  Output: {out}")
    ext.detach()


def cmd_builtin(args):
    ext = FridaExtractor(output_dir=args.output)
    ext.extract_from_builtin_assets()


def cmd_dump_all(args):
    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "dump_all.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    ext.session = frida.get_local_device().attach(args.process)
    script = ext.session.create_script(hook_source)
    done = [False]
    all_data = []

    def on_msg(msg, data):
        if msg["type"] != "send":
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "batch":
            all_data.extend(p["data"])
            print(f"  Batch {p['index']}: {len(p['data'])} objects")

        elif t == "dump_summary":
            out_path = os.path.join(args.output, "dump_all.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(all_data, f, indent=2, ensure_ascii=False)
            total = p.get("totalDumped", len(all_data))
            print(f"\nDumped {total} objects")
            print(f"Saved to: {out_path}")

            class_counts = {}
            for obj in all_data:
                key = f"{obj['ns']}.{obj['n']}"
                class_counts[key] = class_counts.get(key, 0) + 1
            sorted_classes = sorted(class_counts.items(), key=lambda x: -x[1])
            print(f"\nTop 30 classes:")
            for cls, cnt in sorted_classes[:30]:
                print(f"  {cnt:>5}x  {cls}")

        elif t == "done":
            done[0] = True

        elif t == "progress":
            print(f"  Progress: {p['dumped']} objects...")

        elif t == "info":
            print(f"  [>] {p['message']}")

    script.on("message", on_msg)
    script.load()

    timeout = 120
    for i in range(timeout * 2):
        if done[0]:
            break
        time.sleep(0.5)

    script.unload()
    ext.session.detach()
    if not done[0]:
        print("Timeout.")


def cmd_find_key(args):
    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "find_key.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    ext.session = frida.get_local_device().attach(args.process)
    script = ext.session.create_script(hook_source)
    done = [False]
    results = {}

    def on_msg(msg, data):
        if msg["type"] != "send":
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "info":
            print(f"  [>] {p['message']}")

        elif t == "assetbundle_fields":
            results["assetbundles"] = p
            print(f"\n=== AssetBundle Fields ({p['count']} bundles) ===")
            for ab in p["bundles"][:10]:
                fields = ab["fields"]
                interesting = {
                    k: v
                    for k, v in fields.items()
                    if v.get("strVal") or v.get("byteLen") or v.get("arrLen")
                }
                if interesting:
                    print(f"  Bundle: {ab['name']}")
                    for k, v in interesting.items():
                        if v.get("strVal"):
                            print(f'    {k} (offset {v["o"]}): "{v["strVal"][:100]}"')
                        elif v.get("byteLen"):
                            print(f"    {k} (offset {v['o']}): Byte[{v['byteLen']}]")
                            if v.get("hexPreview"):
                                for line in v["hexPreview"].split("\n")[:5]:
                                    print(f"      {line}")
                        elif v.get("arrLen"):
                            print(f"    {k} (offset {v['o']}): array len={v['arrLen']}")
            non_empty = [ab for ab in p["bundles"] if ab["fields"]]
            print(f"\n  {non_empty}/{p['count']} bundles have fields")

        elif t == "bs_addressable":
            results["bs_addressable"] = p
            print(f"\n=== Bs.Addressable Objects ({p['count']}) ===")
            for obj in p["objects"]:
                print(
                    f"  {obj['name']} [{obj['size']}b] fields: {list(obj['fields'].keys())}"
                )
                for k, v in obj["fields"].items():
                    if v.get("strVal") or v.get("innerType"):
                        print(
                            f"    {k}: type={v.get('innerType', '?')} val={v.get('strVal', v.get('intVal', ''))}"
                        )

        elif t == "nkc_byte_fields":
            results["nkc_byte_fields"] = p
            print(f"\n=== NKC Objects with Byte[] Fields ({p['count']}) ===")
            for obj in p["objects"][:20]:
                print(
                    f"  {obj['name']} [{obj['size']}b] field: {obj['fieldName']} (offset {obj['fieldOffset']}) arrayLen={obj['arrayLength']}"
                )
                if obj.get("hexPreview"):
                    for line in obj["hexPreview"].split("\n")[:5]:
                        print(f"    {line}")

        elif t == "done":
            done[0] = True

    script.on("message", on_msg)
    script.load()

    out_path = os.path.join(args.output, "find_key.json")
    timeout = 60
    for i in range(timeout * 2):
        if done[0]:
            break
        time.sleep(0.5)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {out_path}")

    script.unload()
    ext.session.detach()
    if not done[0]:
        print("Timeout.")


def cmd_scan_types(args):
    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "type_scan.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    ext.session = frida.get_local_device().attach(args.process)
    script = ext.session.create_script(hook_source)
    done = [False]

    def on_msg(msg, data):
        if msg["type"] != "send":
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "type_scan":
            out_path = os.path.join(args.output, "type_scan.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(p, f, indent=2, ensure_ascii=False)

            print(f"\n=== GC Handle Type Scan ===")
            print(f"Total objects: {p.get('total', 0):,}")
            print(f"Unique classes: {p.get('uniqueClasses', 0)}")
            print(f"Errors: {p.get('errors', 0)}")
            print(f"Unity classes: {p.get('unityCount', 0)}")
            print(f"NKC/NKM/Bs classes: {p.get('nkcCount', 0)}")
            print(f"Other classes: {p.get('otherCount', 0)}")

            print(f"\n--- Top 50 types by count ---")
            for e in p.get("top50", [])[:50]:
                print(
                    f"  {e['c']:>5}x  {e['ns']}.{e['n']}  (parent: {e['p']}) [{e['img']}]"
                )

            if p.get("nkc"):
                print(f"\n--- NKC/NKM/Bs/Star types ({len(p['nkc'])}) ---")
                for e in p["nkc"]:
                    print(
                        f"  {e['c']:>5}x  {e['ns']}.{e['n']}  (parent: {e['p']}) [{e['img']}]"
                    )

            if p.get("other"):
                print(f"\n--- Other game types (2+ instances) ---")
                for e in p["other"]:
                    print(
                        f"  {e['c']:>5}x  {e['ns']}.{e['n']}  (parent: {e['p']}) [{e['img']}]"
                    )

            print(f"\nSaved to: {out_path}")
            done[0] = True

        elif t == "info":
            print(f"  [>] {p['message']}")

        elif t == "done":
            done[0] = True

    script.on("message", on_msg)
    script.load()

    timeout = 30
    for i in range(timeout * 2):
        if done[0]:
            break
        time.sleep(0.5)

    script.unload()
    ext.session.detach()
    if not done[0]:
        print("Timeout waiting for scan.")


def cmd_catalog(args):
    catalog_path = os.path.join(GAME_DATA_DIR, "StreamingAssets", "aa", "catalog.json")
    cat = CatalogParser(catalog_path).load()
    if args.search:
        results = cat.find_keys_containing(args.search)
        print(f"Keys containing '{args.search}': {len(results)}")
        for k in results:
            print(f"  {k}")
    elif args.images:
        for k in cat.get_image_keys():
            print(f"  {k}")
    else:
        print(json.dumps(cat.summary(), indent=2))


def cmd_decrypt(args):
    print(f"Decrypting bundles from {BUNDLE_DIR}")
    print(f"Output: {args.output}")
    import time

    dec = BundleDecryptor(
        bundle_dir=BUNDLE_DIR,
        output_dir=args.output,
        decrypted_dir=args.decrypted_dir,
    )

    t0 = time.time()
    last_pct = [-1]

    def on_progress(i, total, name):
        pct = (i + 1) * 100 // total
        if pct != last_pct[0]:
            last_pct[0] = pct
            elapsed = time.time() - t0
            eta = elapsed / (i + 1) * (total - i - 1)
            print(
                f"\r  [{i + 1}/{total}] {pct}% ({elapsed:.0f}s elapsed, ~{eta:.0f}s remaining)",
                end="",
                flush=True,
            )

    results = dec.decrypt_all(skip_existing=not args.force, progress_cb=on_progress)
    elapsed = time.time() - t0
    print(
        f"\n\nDone in {elapsed:.1f}s: {results['decrypted']} decrypted, {results['skipped']} skipped, {results['failed']} failed"
    )
    if results["decrypted"] > 0:
        print(f"Decrypted bundles: {dec.decrypted_dir}")


def cmd_decrypt_extract(args):
    print(f"Decrypting + extracting bundles from {BUNDLE_DIR}")
    print(f"Output: {args.output}")
    import time

    dec = BundleDecryptor(
        bundle_dir=BUNDLE_DIR,
        output_dir=args.output,
        decrypted_dir=args.decrypted_dir,
    )

    t0 = time.time()

    print("\n--- Phase 1: Decrypting ---")
    dec_t0 = time.time()
    dec_results = dec.decrypt_all(
        skip_existing=not args.force,
        progress_cb=lambda i, total, n: (
            print(f"\r  Decrypting {i + 1}/{total}", end="", flush=True)
            if (i + 1) % 100 == 0 or i + 1 == total
            else None
        ),
    )
    print(f"\n  Decrypted in {time.time() - dec_t0:.1f}s")

    print("\n--- Phase 2: Extracting (skipping bundles with compressed blocks) ---")
    ext_t0 = time.time()
    ext_results = dec.extract_all_decrypted(
        skip_existing=not args.force,
        progress_cb=lambda i, total, n: (
            print(f"\r  Extracting {i + 1}/{total}", end="", flush=True)
            if (i + 1) % 100 == 0 or i + 1 == total
            else None
        ),
    )
    print(f"\n  Extracted in {time.time() - ext_t0:.1f}s")

    print(f"\n=== Results ({time.time() - t0:.1f}s total) ===")
    print(
        f"  Decryption: {dec_results['decrypted']} ok ({dec_results.get('bitblended', 0)} with bit-blend masks), {dec_results['skipped']} skipped, {dec_results['failed']} failed"
    )
    print(
        f"  Extraction: {ext_results['extracted']} ok, {ext_results['skipped']} skipped, {ext_results['failed']} failed"
    )
    for atype, count in ext_results["assets"].items():
        if count > 0:
            print(f"    {atype}: {count}")
    print(f"\nOutput: {args.output}")


def cmd_hook_filename(args):
    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "hook_filename.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    ext.session = frida.get_local_device().attach(args.process)
    script = ext.session.create_script(hook_source)
    filenames = {"md5_input": [], "bp2_id": [], "fnm_input": []}

    def on_msg(msg, data):
        if msg["type"] != "send":
            if msg["type"] == "error":
                print(f"  [ERROR] {msg.get('description', msg)}")
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "info":
            print(f"  [>] {p['message']}")
        elif t == "error":
            print(f"  [!] {p['message']}")
        elif t == "filename":
            label = p["label"]
            fn = p["filename"]
            cnt = p["count"]
            print(f'  [#{cnt}] {label}: "{fn}"')
            filenames.setdefault(label, []).append(fn)
        elif t == "mask_bytes":
            idx = p.get("index", "?")
            mask = p.get("maskBytes") or p.get("maskLongs") or p.get("mask", "?")
            print(f"  [MASK #{idx}] {mask}")
            filenames.setdefault("mask_bytes", []).append({"index": idx, "mask": mask})
        elif t == "blend_info":
            data = p["data"]
            name = data.get("baseStreamName", "?")
            bsClass = data.get("baseStreamClass", "?")
            skip = data.get("skipBytes", "?")
            mask = data.get("maskBytes", "?")
            print(
                f"  [STREAM #{data.get('index', '?')}] mask={mask} skip={skip} bsClass={bsClass} name={name}"
            )
            filenames.setdefault("blend_info", []).append(data)
        elif t == "stream":
            data = p["data"]
            f = data.get("file", "?")
            bs = data.get("baseStreamClass", "?")
            sk = data.get("skip", "?")
            m = data.get("maskBytes", "?")
            print(f"  [#{data.get('index', '?')}] mask={m} file={f} skip={sk}")
            filenames.setdefault("streams", []).append(data)
        elif t == "done":
            filenames["_done"] = True

    script.on("message", on_msg)
    script.load()

    timeout = args.timeout
    for i in range(timeout * 2):
        if filenames.get("_done"):
            break
        time.sleep(0.5)

    stream_count = len(filenames.get("streams", []))
    if stream_count > 0:
        mask_path = os.path.join(args.output, "mask_map.json")
        mask_map = {}
        for s in filenames["streams"]:
            fname = s.get("file", "")
            bname = os.path.basename(fname) if fname else ""
            mask_map[bname] = s.get("maskBytes", "")
        with open(mask_path, "w", encoding="utf-8") as f:
            json.dump(mask_map, f, indent=2)
        print(f"Mask map ({len(mask_map)} bundles) saved to {mask_path}")

    print(f"\n=== Summary ===")
    for label, fns in filenames.items():
        if label.startswith("_"):
            continue
        if label == "mask_bytes":
            print(f"  {label}: {len(fns)} entries")
            continue
        if label == "streams":
            print(f"  {label}: {len(fns)} entries")
            continue
        if not isinstance(fns, list) or len(fns) == 0:
            continue
        unique = list(dict.fromkeys(fns))
        print(f"  {label}: {len(fns)} calls, {len(unique)} unique")
        for fn in unique[:20]:
            print(f'    - "{fn}"')
        if len(unique) > 20:
            print(f"    ... and {len(unique) - 20} more")

    out_path = os.path.join(args.output, "hook_filename_results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(filenames, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to {out_path}")

    stream_count = len(filenames.get("streams", []))
    if stream_count > 0:
        mask_path = os.path.join(args.output, "mask_map.json")
        mask_map = {}
        for s in filenames["streams"]:
            fname = s.get("file", "")
            bname = os.path.basename(fname) if fname else ""
            mask_map[bname] = s.get("maskBytes", "")
        with open(mask_path, "w", encoding="utf-8") as f:
            json.dump(mask_map, f, indent=2)
        print(f"Mask map ({len(mask_map)} bundles) saved to {mask_path}")

    script.unload()
    ext.session.detach()


def cmd_hook_bitblend(args):
    import json as _json

    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "hook_bitblend.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    ext.session = frida.get_local_device().attach(args.process)
    script = ext.session.create_script(hook_source)
    results = {
        "xor_reads": [],
        "blend_reads": [],
    }

    def on_msg(msg, data):
        if msg["type"] != "send":
            if msg["type"] == "error":
                print(f"  [ERROR] {msg.get('description', msg)}")
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "info":
            print(f"  [>] {p['message']}")
        elif t == "error":
            print(f"  [!] {p['message']}")
        elif t == "xor_read":
            idx = len(results["xor_reads"])
            if idx < 5:
                hex_str = " ".join(f"{b:02x}" for b in (data or b"")[:64])
                print(
                    f"  [XOR #{idx}] offset={p['offset']} count={p['count']}: {hex_str}..."
                )
            if data:
                results["xor_reads"].append(data)
        elif t == "blend_read":
            idx = len(results["blend_reads"])
            if idx < 5:
                hex_str = " ".join(f"{b:02x}" for b in (data or b"")[:64])
                print(
                    f"  [BLEND #{idx}] offset={p['offset']} count={p['count']}: {hex_str}..."
                )
            if data:
                results["blend_reads"].append(data)
        elif t == "done":
            results["done"] = True

    script.on("message", on_msg)
    script.load()

    timeout = args.timeout
    for i in range(timeout * 2):
        if results.get("done"):
            break
        time.sleep(0.5)

    xor_count = len(results["xor_reads"])
    blend_count = len(results["blend_reads"])
    print(f"\nCaptured: {xor_count} XOR reads, {blend_count} blend reads")

    if xor_count > 0 and blend_count > 0:
        out_path = os.path.join(args.output, "bitblend_capture")
        os.makedirs(out_path, exist_ok=True)
        for i, d in enumerate(results["xor_reads"]):
            with open(os.path.join(out_path, f"xor_{i}.bin"), "wb") as f:
                f.write(d)
        for i, d in enumerate(results["blend_reads"]):
            with open(os.path.join(out_path, f"blend_{i}.bin"), "wb") as f:
                f.write(d)
        print(
            f"Saved to {out_path}/ ({xor_count} xor_*.bin, {blend_count} blend_*.bin)"
        )

        if xor_count > 0 and blend_count > 0:
            print("\n=== Quick analysis ===")
            xor0 = results["xor_reads"][0]
            blend0 = results["blend_reads"][0]
            min_len = min(len(xor0), len(blend0), 64)
            diff_count = sum(
                1 for a, b in zip(xor0[:min_len], blend0[:min_len]) if a != b
            )
            print(
                f"XOR[0] vs BLEND[0]: {diff_count}/{min_len} bytes differ in first {min_len}"
            )
            if diff_count > 0 and diff_count < min_len:
                first_diff = next(i for i in range(min_len) if xor0[i] != blend0[i])
                print(f"First difference at byte {first_diff}")
                print(
                    f"XOR[{first_diff}:{first_diff + 8}]:  {' '.join(f'{b:02x}' for b in xor0[first_diff : first_diff + 8])}"
                )
                print(
                    f"BLN[{first_diff}:{first_diff + 8}]:  {' '.join(f'{b:02x}' for b in blend0[first_diff : first_diff + 8])}"
                )
                print(
                    f"XOR[{first_diff}] ^ BLN[{first_diff}] = {xor0[first_diff] ^ blend0[first_diff]:08b}"
                )

    script.unload()
    ext.session.detach()


def cmd_extract_decrypted(args):
    print(f"Extracting from decrypted bundles")
    dec = BundleDecryptor(
        bundle_dir=BUNDLE_DIR,
        output_dir=args.output,
        decrypted_dir=args.decrypted_dir,
    )
    source_dir = dec.resolve_captured_dir()
    print(f"Source: {source_dir}")

    def on_progress(i, total, name):
        if i % 50 == 0 or i == total - 1:
            print(f"  [{i + 1}/{total}] {name}")

    results = dec.extract_all_decrypted(
        skip_existing=not args.force, progress_cb=on_progress
    )
    print(
        f"\nExtraction complete: {results['extracted']} bundles, {results['skipped']} skipped, {results['failed']} failed"
    )
    for atype, count in results["assets"].items():
        if count > 0:
            print(f"  {atype}: {count}")


def cmd_capture_decrypt(args):
    decrypted_dir = args.decrypted_dir or os.path.join(args.output, "decrypted_bundles")
    os.makedirs(decrypted_dir, exist_ok=True)

    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "capture_decrypt.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    js_dir = decrypted_dir.replace("\\", "\\\\")
    hook_source = hook_source.replace(
        "var OUTPUT_DIR = null;", f"var OUTPUT_DIR = '{js_dir}';"
    )

    if ext.session is None:
        print("Failed to establish Frida session.")
        sys.exit(1)

    script = ext.session.create_script(hook_source)

    captured_bundles = []
    done = [False]

    def on_msg(msg, data):
        if msg["type"] != "send":
            if msg["type"] == "error":
                print(f"  [SCRIPT ERROR] {msg.get('description', msg)}")
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "ready":
            print("Hook ready. Browse the game to trigger bundle loading...")
        elif t == "info":
            print(f"  [>] {p['message']}")
        elif t == "error":
            print(f"  [!] {p['message']}")
        elif t == "bundle_open":
            print(f"  [OPEN] {p['name']} (from: {p.get('originalName', '?')})")
        elif t == "bundle_start":
            print(f"  [READ] {p['name']} header={p['header']}")
        elif t == "bundle_done":
            valid = "VALID UnityFS" if p.get("validUnityFS") else "INVALID header"
            print(f"  [DONE] {p['name']} ({p['bytes']:,} bytes) [{valid}]")
            captured_bundles.append(p)
        elif t == "progress":
            print(f"  [...] {p['name']}: {p['bytes']:,} bytes")
        elif t == "capture_complete":
            print(f"\nCapture complete: {p['totalBundles']} bundles")
            done[0] = True
        elif t == "done":
            done[0] = True
        elif t == "status":
            print(
                f"  Status: {p['active']} active, {p['done']} done, {p['totalCaptured']} total"
            )

    script.on("message", on_msg)
    script.load()

    print(f"Output: {decrypted_dir}")
    print("Press Ctrl+C to stop capturing and finalize...")

    try:
        while not done[0]:
            time.sleep(1)
    except KeyboardInterrupt:
        pass

    print("\nFinalizing...")
    script.post({"type": "finalize"})
    time.sleep(2)

    print(f"\n=== Results ===")
    print(f"Captured: {len(captured_bundles)} bundles")
    valid = sum(1 for b in captured_bundles if b.get("validUnityFS"))
    invalid = len(captured_bundles) - valid
    print(f"Valid UnityFS: {valid}, Invalid: {invalid}")
    total_bytes = sum(b["bytes"] for b in captured_bundles)
    print(f"Total data: {total_bytes:,} bytes ({total_bytes / 1024 / 1024:.1f} MB)")

    if captured_bundles:
        print(f"\nBundles:")
        for b in captured_bundles:
            v = "OK" if b.get("validUnityFS") else "BAD"
            print(f"  [{v}] {b['name']}: {b['bytes']:,} bytes")

    print(f"\nOutput directory: {decrypted_dir}")

    script.unload()
    ext.session.detach()


def cmd_hook_banner_dates(args):
    import json as _json

    ext = FridaExtractor(output_dir=args.output)
    if not ext.attach(args.process):
        sys.exit(1)

    hooks_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hooks", "hook_banner_dates.js"
    )
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    ext.session = frida.get_local_device().attach(args.process)
    script = ext.session.create_script(hook_source)
    all_results = {}

    def on_msg(msg, data):
        if msg["type"] != "send":
            if msg["type"] == "error":
                print(f"  [ERROR] {msg.get('description', msg)}")
            return
        p = msg["payload"]
        t = p.get("type", "")

        if t == "status":
            print(f"  [>] {p['msg']}")
        elif t == "error":
            print(f"  [!] {p['msg']}")
        elif t == "interval_users":
            print(f"  IntervalTime users: {p['count']} classes")
            all_results["interval_users"] = p["users"]
        elif t == "gacha_schedules":
            print(f"  GachaScheduleData instances: {p['count']}")
            all_results["gacha_schedules"] = p["results"]
        elif t == "banner_slots":
            print(f"  BannerSlotInfo instances: {p['count']}")
            all_results["banner_slots"] = p["results"]
        elif t == "banner_manager":
            print(f"  BannerManager instances: {p['count']}")
            all_results["banner_manager"] = p["results"]
        elif t == "done":
            all_results["done"] = True

    script.on("message", on_msg)
    script.load()

    timeout = args.timeout
    for i in range(timeout * 2):
        if all_results.get("done"):
            break
        time.sleep(0.5)

    script.unload()
    ext.session.detach()

    out_path = os.path.join(args.output, "banner_dates.json")
    with open(out_path, "w", encoding="utf-8") as f:
        _json.dump(all_results, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to: {out_path}")

    if not all_results.get("done"):
        print("Timeout - partial results saved.")


def main():
    parser = argparse.ArgumentParser(description="Star Survivor Asset Extractor")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status").set_defaults(func=cmd_status)
    p = sub.add_parser("scan", help="Scan loaded objects")
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=lambda a: None)
    p = sub.add_parser("extract")
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=cmd_extract)
    p = sub.add_parser("builtin")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=cmd_builtin)
    p = sub.add_parser("dump-all")
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=cmd_dump_all)
    p = sub.add_parser("find-key")
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=cmd_find_key)
    p = sub.add_parser("scan-types")
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=cmd_scan_types)
    p = sub.add_parser("catalog")
    p.add_argument("--search")
    p.add_argument("--images", action="store_true")
    p.set_defaults(func=cmd_catalog)
    p = sub.add_parser("decrypt", help="Decrypt all encrypted bundles from eb/")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--decrypted-dir", default=None)
    p.add_argument("--force", action="store_true", help="Re-decrypt existing files")
    p.set_defaults(func=cmd_decrypt)
    p = sub.add_parser("decrypt-extract", help="Decrypt and extract all bundles")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--decrypted-dir", default=None)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_decrypt_extract)
    p = sub.add_parser(
        "extract-decrypted", help="Extract from already-decrypted bundles"
    )
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--decrypted-dir", default=None)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_extract_decrypted)
    p = sub.add_parser(
        "hook-bitblend",
        help="Hook PartialBitBlendReadStream to capture full decryption",
    )
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--timeout", type=int, default=120)
    p.set_defaults(func=cmd_hook_bitblend)
    p = sub.add_parser(
        "hook-filename",
        help="Hook FileNameMasking/ComputeMd5Hash to capture bundle filenames",
    )
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--timeout", type=int, default=120)
    p.set_defaults(func=cmd_hook_filename)
    p = sub.add_parser(
        "capture-decrypt",
        help="Capture decrypted bundles via Frida stream hook",
    )
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--decrypted-dir", default=None)
    p.set_defaults(func=cmd_capture_decrypt)
    p = sub.add_parser(
        "hook-banner-dates",
        help="Scan GC heap for GachaScheduleData/BannerSlotInfo to extract banner dates",
    )
    p.add_argument("--process", default="StarSavior.exe")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--timeout", type=int, default=30)
    p.set_defaults(func=cmd_hook_banner_dates)
    args = parser.parse_args()
    if args.command:
        args.func(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
