#!/usr/bin/env python3
import frida
import json
import time
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HOOKS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks")
OUTPUT_DIR = r"D:\starsavior-extractor\output"


def main():
    hooks_path = os.path.join(HOOKS_DIR, "hook_discover_banner.js")
    with open(hooks_path, "r", encoding="utf-8") as f:
        hook_source = f.read()

    session = frida.get_local_device().attach("StarSavior.exe")
    script = session.create_script(hook_source)
    results = {}

    def on_msg(msg, data):
        if msg["type"] != "send":
            if msg["type"] == "error":
                print(f"  [ERROR] {msg.get('description', msg)}")
            return
        p = msg["payload"]
        t = p.get("type", "")
        if t == "status":
            print(f"  [>] {p['msg']}")
        elif t == "datetime_classes":
            keys = list(p["classes"].keys())
            print(f"  DateTime classes: {p['count']}")
            for k in keys[:50]:
                fields_str = str(p["classes"][k])
                print(f"    {repr(k)}: {fields_str}")
            if len(keys) > 50:
                print(f"    ... and {len(keys) - 50} more")
            results["datetime_classes"] = p["classes"]
        elif t == "banner_classes":
            print(f"  Banner string classes: {p['count']}")
            for r in p["results"][:30]:
                print(
                    f"    {repr(r['namespace'] + '.' + r['className'])} -> {repr(r['matchedField'])} = {repr(r['matchedValue'][:80])}"
                )
            results["banner_classes"] = p["results"]
        elif t == "interval_candidates":
            keys = list(p["candidates"].keys())
            print(f"  IntervalTime candidates: {p['count']}")
            for k in keys[:30]:
                c = p["candidates"][k]
                print(f"    {repr(k)}")
                print(f"      DT fields: {c['dateTimeFields']}")
                print(f"      Used by ({len(c['usedBy'])}): {c['usedBy'][:5]}")
            results["interval_candidates"] = p["candidates"]
        elif t == "done":
            results["done"] = True

    script.on("message", on_msg)
    script.load()

    for i in range(120):
        if results.get("done"):
            break
        time.sleep(0.5)

    script.unload()
    session.detach()

    out_path = os.path.join(OUTPUT_DIR, "banner_discovery.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {out_path}")


if __name__ == "__main__":
    main()
