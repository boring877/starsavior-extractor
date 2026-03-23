"""
Search decrypted bundles for CLIENT_CONST_TEMPLET and extract/decrypt it.
Handles both encrypted (v0/v1/v2) and unencrypted (plain JSON/text) templets.
"""

import os
import sys
import io
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from decrypt_templets_v2 import (
    decrypt_templet,
    extract_textasset_bytes_from_bundle,
    DECRYPTED_BUNDLES_DIR,
    OUTPUT_DIR,
)

TARGET_NAMES = ["CLIENT_CONST_TEMPLET", "CONST_TEMPLET"]


def extract_text(name, script_data):
    text, method = decrypt_templet(script_data, name)
    if text is not None:
        return text, method
    try:
        text = script_data.decode("utf-8-sig")
        return text, "unencrypted (plain text)"
    except UnicodeDecodeError:
        return None, "decode failed"


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    bundle_files = sorted(DECRYPTED_BUNDLES_DIR.glob("*.bundle"))
    print(f"Searching {len(bundle_files)} decrypted bundles for {TARGET_NAMES}...")

    found = []

    for i, bundle_path in enumerate(bundle_files):
        bundle_data = bundle_path.read_bytes()
        assets = extract_textasset_bytes_from_bundle(bundle_data)

        for name, script_data in assets:
            if any(t in name.upper() for t in TARGET_NAMES):
                print(
                    f"  FOUND: '{name}' in {bundle_path.name} ({len(script_data):,} bytes)"
                )
                text, method = extract_text(name, script_data)
                if text is not None:
                    if text.startswith("\ufeff"):
                        text = text[1:]
                    is_json = text.strip().startswith("{") or text.strip().startswith(
                        "["
                    )
                    ext = ".json" if is_json else ".txt"
                    out_path = OUTPUT_DIR / f"{name}{ext}"
                    out_path.write_text(text, encoding="utf-8")
                    found.append((name, method, len(text), is_json, out_path))
                    print(
                        f"    Extracted ({method}): {len(text):,} chars -> {out_path}"
                    )
                else:
                    print(f"    FAILED: {method}")
                    found.append((name, method, 0, False, None))

        if (i + 1) % 100 == 0:
            print(f"  Scanned {i + 1}/{len(bundle_files)} bundles...")

    print(f"\nScanned all {len(bundle_files)} bundles.")
    if found:
        print(f"\nResults ({len(found)} matches):")
        for name, method, size, is_json, path in found:
            print(
                f"  {method:30s} {size:>10,} chars  {'JSON' if is_json else 'TXT':4s}  {name}"
            )
            if path:
                print(f"    -> {path}")
    else:
        print("\nNo CLIENT_CONST_TEMPLET found in any bundle.")


if __name__ == "__main__":
    main()
