"""
Decrypt templet .bytes files directly from decrypted Unity bundles.
Bypasses UnityPy which corrupts binary TextAsset data during extraction.
Uses the correct magic constant 0x2B21DE00 and K4os-compatible LZ4 framing.
"""

import os
import sys
import io
import json
import struct
import hashlib
import lz4.frame
import lz4.block
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TEMPLET_MAGIC = 0x2B21DE00  # Correct magic: 0x2B21DE00 (723639808 & 0xFFFFFF00)
DECRYPTED_BUNDLES_DIR = Path(r"D:\starsavior-extractor\output\decrypted")
OUTPUT_DIR = Path(r"D:\starsavior-extractor\output\decrypted_templets")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def compute_mask(filename: str) -> bytes:
    if not filename.endswith(".bytes"):
        filename += ".bytes"
    return hashlib.md5(filename.encode("utf-8")).digest()


def apply_mask(data: bytes, mask: bytes, offset: int = 0) -> bytes:
    result = bytearray(data)
    mask_len = len(mask)
    for i in range(len(result)):
        result[i] ^= mask[(offset + i) % mask_len]
    return bytes(result)


def decompress_lz4(data: bytes) -> bytes:
    try:
        return lz4.frame.decompress(data)
    except Exception:
        pass

    # Manual block parsing as fallback
    try:
        offset = 7  # skip frame header
        all_dec = b""
        while offset < len(data):
            if offset + 4 > len(data):
                break
            bs = struct.unpack_from("<I", data, offset)[0]
            offset += 4
            if bs == 0:
                break
            uncomp = bool(bs & 0x80000000)
            actual = bs & 0x7FFFFFFF
            if actual > len(data) - offset:
                break
            block = data[offset : offset + actual]
            offset += actual
            if uncomp:
                all_dec += block
            else:
                # Try to find the right uncompressed size
                for usize in range(actual, max(actual * 4, 65536)):
                    try:
                        result = lz4.block.decompress(block, uncompressed_size=usize)
                        all_dec += result
                        break
                    except lz4.block.LZ4BlockError:
                        if "corrupt" in str(lz4.block.LZ4BlockError("x")).lower():
                            return None
                        continue
                else:
                    return None
        return all_dec if all_dec else None
    except Exception:
        return None


def extract_textasset_bytes_from_bundle(bundle_data: bytes) -> list[tuple[str, bytes]]:
    """
    Extract raw TextAsset name+bytes pairs from a decrypted Unity bundle.
    Uses UnityPy for parsing but reads raw bytes directly.
    """
    import UnityPy

    UnityPy.config.FALLBACK_UNITY_VERSION = "6000.0.61f1"

    results = []
    try:
        env = UnityPy.load(io.BytesIO(bundle_data))
    except Exception:
        return results

    for obj in env.objects:
        if obj.type.name == "TextAsset":
            try:
                data = obj.read()
                name = data.m_Name
                raw = obj.get_raw_data()

                if not raw or len(raw) < 8:
                    continue

                # Parse raw data structure:
                # [4 bytes: name_len LE] [name string] [padding to 4-byte align]
                # [4 bytes: script_len LE] [script bytes]
                name_len = struct.unpack_from("<I", raw, 0)[0]
                name_end = 4 + name_len
                # Align to 4 bytes
                name_end_aligned = (name_end + 3) & ~3
                if name_end_aligned + 4 > len(raw):
                    continue
                script_len = struct.unpack_from("<I", raw, name_end_aligned)[0]
                script_start = name_end_aligned + 4
                script_data = raw[script_start : script_start + script_len]

                if len(script_data) >= 4:
                    results.append((name, script_data))
            except Exception as e:
                continue

    return results


def decrypt_templet(data: bytes, filename: str) -> tuple[str | None, str]:
    if len(data) <= 4:
        return None, "too short"

    magic = struct.unpack_from("<i", data, 0)[0]

    if (magic & 0xFFFFFF00) != TEMPLET_MAGIC:
        version = magic & 0xFF
        return None, f"unknown magic {magic:#010x} (version {version})"

    version_byte = magic & 0xFF
    stripped = data[4:]

    if version_byte == 0 or version_byte == 1:
        result = decompress_lz4(stripped)
        if result is not None:
            try:
                text = result.decode("utf-8-sig")
                return text, f"v{version_byte}: lz4 + json"
            except UnicodeDecodeError:
                return result.hex(), f"v{version_byte}: lz4 (not utf8)"
        return stripped[:200].hex(), f"v{version_byte}: raw (lz4 failed)"

    elif version_byte == 2:
        mask = compute_mask(filename)
        unmasked = apply_mask(stripped, mask)
        result = decompress_lz4(unmasked)
        if result is not None:
            try:
                text = result.decode("utf-8-sig")
                return text, "v2: bitblend + lz4 + json"
            except UnicodeDecodeError:
                return result.hex(), "v2: bitblend + lz4 (not utf8)"
        return unmasked[:200].hex(), "v2: bitblend raw (lz4 failed)"

    else:
        return None, f"unknown version byte: {version_byte}"


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Decrypt TEMPLET .bytes files from bundles"
    )
    parser.add_argument(
        "--limit", type=int, default=0, help="Max bundles to process (0=all)"
    )
    parser.add_argument(
        "--name", type=str, default="", help="Process specific bundle by hash"
    )
    parser.add_argument("--output", type=str, default="", help="Output directory")
    parser.add_argument(
        "--force", action="store_true", help="Re-process existing files"
    )
    args = parser.parse_args()

    out_dir = Path(args.output) if args.output else OUTPUT_DIR

    if args.name:
        bundle_files = [DECRYPTED_BUNDLES_DIR / f"{args.name}.bundle"]
    else:
        bundle_files = sorted(DECRYPTED_BUNDLES_DIR.glob("*.bundle"))

    if args.limit > 0:
        bundle_files = bundle_files[: args.limit]

    print(f"Found {len(bundle_files)} decrypted bundles")

    success = 0
    failed = 0
    skipped_files = 0
    results = []

    for i, bundle_path in enumerate(bundle_files):
        bundle_data = bundle_path.read_bytes()
        assets = extract_textasset_bytes_from_bundle(bundle_data)

        for name, script_data in assets:
            ext = ".json"
            out_path = out_dir / f"{name}{ext}"

            if not args.force and out_path.exists():
                skipped_files += 1
                continue

            text, method = decrypt_templet(script_data, name)

            if text is not None:
                is_json = text.strip().startswith("{") or text.strip().startswith("[")
                # Also check for UTF-8 BOM
                if text.startswith("\ufeff"):
                    text = text[1:]
                    is_json = text.strip().startswith("{") or text.strip().startswith(
                        "["
                    )

                ext = ".json" if is_json else ".txt"
                out_path = out_dir / f"{name}{ext}"
                out_path.write_text(text, encoding="utf-8")
                results.append((name, method, len(text), is_json, str(out_path)))
                success += 1
            else:
                skipped_files += 1

        if (i + 1) % 20 == 0 or i + 1 == len(bundle_files):
            print(
                f"  {i + 1}/{len(bundle_files)} bundles ({success} ok, {skipped_files} skipped)"
            )

    print(f"\nDone: {success} decrypted, {skipped_files} skipped")
    print(f"Output: {out_dir}")

    if results:
        json_files = [(n, m, sz, p) for n, m, sz, is_j, p in results if is_j]
        print(f"\nJSON files: {len(json_files)}")
        print("\nLargest JSON files:")
        json_files.sort(key=lambda x: -x[2])
        for name, method, size, path in json_files[:30]:
            print(f"  {method:30s} {size:>10,} bytes  {name}")

        txt_files = [(n, m, sz, p) for n, m, sz, is_j, p in results if not is_j]
        if txt_files:
            print(f"\nNon-JSON files: {len(txt_files)}")
            for name, method, size, path in txt_files[:10]:
                print(f"  {method:30s} {size:>10,} bytes  {name}")


if __name__ == "__main__":
    main()
