import hashlib
import json
import numpy as np
import os
from pathlib import Path
from typing import Optional

from .asset_extractor import AssetExtractor

KNOWN_PLAINTEXT = bytes(
    [
        0x55,
        0x6E,
        0x69,
        0x74,
        0x79,
        0x46,
        0x53,
        0x00,
        0x00,
        0x00,
        0x00,
        0x08,
        0x35,
        0x2E,
        0x78,
        0x2E,
    ]
)

KEY_SIZE = 16
ENCRYPTION_LIMIT = 102400
TYPE1_KEY = bytes([0xFF, 0xBB, 0xCC, 0x21])


def derive_key_from_filename(bundle_name: str) -> bytes:
    name32 = bundle_name[:32]
    return hashlib.md5((name32 + ".bytes").encode("utf-8")).digest()


def derive_key(encrypted_first_16: bytes) -> bytes:
    return bytes(e ^ p for e, p in zip(encrypted_first_16[:KEY_SIZE], KNOWN_PLAINTEXT))


def is_type1(encrypted_first_16: bytes) -> bool:
    derived = derive_key(encrypted_first_16)
    return derived == TYPE1_KEY * 4


def apply_bitblend(data: bytearray, mask: bytes, start_pos: int = 0) -> bytearray:
    mask_len = len(mask)
    if mask_len == 0:
        return data
    for i in range(len(data)):
        data[i] ^= mask[(start_pos + i) % mask_len]
    return data


def reverse_bitblend_block(data: bytes, mask: bytes, block_file_offset: int) -> bytes:
    result = bytearray(data)
    apply_bitblend(result, mask, block_file_offset)
    return bytes(result)


def load_mask_map(output_dir: str) -> dict:
    mask_path = Path(output_dir) / "mask_map.json"
    if not mask_path.exists():
        return {}
    with open(mask_path) as f:
        return json.load(f)


def parse_blocks_info(
    data: bytes,
    blocks_info_offset: int,
    blocks_info_size: int,
    blocks_info_compressed: int,
) -> list:
    blocks = []
    if blocks_info_compressed:
        import lz4.block

        try:
            bi_data = lz4.block.decompress(
                data[blocks_info_offset : blocks_info_offset + blocks_info_size]
            )
            data = bi_data
        except Exception:
            return blocks
        blocks_info_offset = 0
        blocks_info_size = len(bi_data)

    pos = blocks_info_offset
    end = blocks_info_offset + blocks_info_size
    archive_version = int.from_bytes(data[8:12], "big")

    storage_count = int.from_bytes(data[pos : pos + 4], "big")
    pos += 4

    if archive_version >= 7:
        _ = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4

    for _ in range(storage_count):
        uncompressed_size = int.from_bytes(data[pos : pos + 4], "big")
        compressed_size = int.from_bytes(data[pos + 4 : pos + 8], "big")
        flags = int.from_bytes(data[pos + 8 : pos + 12], "big")
        pos += 12

        if archive_version >= 7:
            _ = int.from_bytes(data[pos : pos + 4], "big")
            pos += 4

        blocks.append(
            {
                "uncompressed_size": uncompressed_size,
                "compressed_size": compressed_size,
                "flags": flags,
            }
        )
    return blocks


def get_bundle_block_info(data: bytes) -> tuple:
    if len(data) < 64:
        return None, []

    if data[:8] != b"UnityFS\x00":
        return None, []

    archive_version = int.from_bytes(data[8:12], "big")
    pos = 12

    version_str = b""
    while data[pos] != 0:
        pos += 1
    pos += 1  # null terminator for player version
    while data[pos] != 0:
        pos += 1
    pos += 1  # null terminator for engine version

    file_size = int.from_bytes(data[pos : pos + 8], "big")
    pos += 8
    compressed_blocks_size = int.from_bytes(data[pos : pos + 4], "big")
    uncompressed_blocks_size = int.from_bytes(data[pos + 4 : pos + 8], "big")
    flags = int.from_bytes(data[pos + 8 : pos + 12], "big")
    pos += 12

    if archive_version >= 8:
        pos += 16  # align to 16 bytes

    is_compressed = (flags & 0x3) != 0
    return pos, parse_blocks_info(data, pos, compressed_blocks_size, is_compressed)


def decrypt_bundle(
    data: bytes, bundle_name: str = "", mask: Optional[bytes] = None
) -> bytes:
    if len(data) < KEY_SIZE:
        return data
    if data[:7] == b"UnityFS":
        return data
    first16 = data[:KEY_SIZE]
    if is_type1(first16):
        key = TYPE1_KEY * (128 // 4)
        limit = 128
    else:
        if bundle_name:
            key = derive_key_from_filename(bundle_name)
        else:
            key = derive_key(first16)
        limit = ENCRYPTION_LIMIT
    result = bytearray(data)
    end = min(len(result), limit)
    for i in range(end):
        result[i] ^= key[i % len(key)]
    return bytes(result)


def parse_mask_hex(mask_hex: str) -> bytes:
    return bytes(int(x, 16) for x in mask_hex.strip().split())


def decrypt_file(src: str, dst: str, mask: Optional[bytes] = None) -> int:
    with open(src, "rb") as f:
        data = f.read()
    if len(data) < KEY_SIZE or data[:7] == b"UnityFS":
        return 0
    bundle_name = Path(src).stem
    dec = decrypt_bundle(data, bundle_name, mask)
    with open(dst, "wb") as f:
        f.write(dec)
    return len(dec)


def verify_decrypted_header(data: bytes) -> bool:
    return len(data) >= 32 and data[:7] == b"UnityFS" and data[7] == 0


def find_unityfs_offset(data: bytes, max_scan: int = 64) -> int:
    if not data:
        return -1
    limit = min(len(data), max_scan)
    return data[:limit].find(b"UnityFS")


class BundleDecryptor:
    def __init__(
        self, bundle_dir: str, output_dir: str, decrypted_dir: Optional[str] = None
    ):
        self.bundle_dir = Path(bundle_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.decrypted_dir = (
            Path(decrypted_dir) if decrypted_dir else self.output_dir / "decrypted"
        )
        self.decrypted_dir.mkdir(parents=True, exist_ok=True)
        self.asset_extractor = AssetExtractor(str(self.output_dir))
        self.normalized_dir = self.output_dir / "normalized_bundles"
        self.normalized_dir.mkdir(parents=True, exist_ok=True)
        self.mask_map = load_mask_map(str(self.output_dir))

    def resolve_captured_dir(self) -> Path:
        if self.decrypted_dir.exists():
            has_files = any(self.decrypted_dir.glob("*.bundle")) or any(
                self.decrypted_dir.glob("*.decrypted")
            )
            if has_files:
                return self.decrypted_dir

        captured_dir = self.output_dir / "decrypted_bundles"
        if captured_dir.exists():
            has_files = any(captured_dir.glob("*.bundle")) or any(
                captured_dir.glob("*.decrypted")
            )
            if has_files:
                return captured_dir

        return self.decrypted_dir

    def iter_decrypted_files(self) -> list[Path]:
        source_dir = self.resolve_captured_dir()
        files = list(source_dir.glob("*.bundle"))
        files.extend(source_dir.glob("*.decrypted"))
        files.sort()
        return files

    def prepare_bundle_for_extraction(self, src: Path) -> tuple[Optional[Path], int]:
        with open(src, "rb") as f:
            data = f.read()

        if len(data) < 16:
            return None, -1

        offset = find_unityfs_offset(data)
        if offset < 0:
            return None, -1

        normalized = data[offset:]
        if not verify_decrypted_header(normalized):
            return None, offset

        dst = self.normalized_dir / f"{src.stem}.bundle"
        if not dst.exists() or dst.stat().st_size != len(normalized):
            with open(dst, "wb") as f:
                f.write(normalized)

        return dst, offset

    def decrypt_all(self, skip_existing: bool = True, progress_cb=None) -> dict:
        files = sorted(self.bundle_dir.glob("*.bundle"))
        total = len(files)
        r = {"decrypted": 0, "skipped": 0, "failed": 0, "bitblended": 0, "total": total}
        has_masks = len(self.mask_map) > 0
        for i, p in enumerate(files):
            if progress_cb:
                progress_cb(i, total, p.name)
            dst = self.decrypted_dir / p.name
            if skip_existing and dst.exists():
                r["skipped"] += 1
                continue
            try:
                mask = None
                if has_masks and p.name in self.mask_map:
                    mask = parse_mask_hex(self.mask_map[p.name])
                    r["bitblended"] += 1
                decrypt_file(str(p), str(dst), mask)
                r["decrypted"] += 1
            except Exception as e:
                print(f"\n  [FAIL] {p.name}: {e}")
                r["failed"] += 1
        return r

    def extract_all_decrypted(
        self, skip_existing: bool = True, progress_cb=None
    ) -> dict:
        import warnings
        from UnityPy.exceptions import UnityVersionFallbackWarning

        files = self.iter_decrypted_files()
        total = len(files)
        r = {
            "extracted": 0,
            "skipped": 0,
            "failed": 0,
            "total": total,
            "assets": {
                "Texture2D": 0,
                "Sprite": 0,
                "TextAsset": 0,
                "AudioClip": 0,
                "other": 0,
            },
        }
        for i, p in enumerate(files):
            if progress_cb:
                progress_cb(i, total, p.name)
            stem = p.stem
            out_dirs = [
                self.output_dir / "textures" / stem,
                self.output_dir / "sprites" / stem,
                self.output_dir / "text_assets" / stem,
            ]
            if skip_existing and any(d.exists() for d in out_dirs):
                r["skipped"] += 1
                continue
            try:
                prepared_path, offset = self.prepare_bundle_for_extraction(p)
                if prepared_path is None:
                    print(f"  Skipping {p.name}: UnityFS header not found near start")
                    r["failed"] += 1
                    continue
                if offset > 0:
                    print(f"  Normalized {p.name}: trimmed {offset} leading bytes")
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UnityVersionFallbackWarning)
                    assets = self.asset_extractor.extract_from_file(str(prepared_path))
                for a in assets:
                    t = a.asset_type
                    r["assets"][t] = r["assets"].get(t, 0) + 1
                if assets:
                    r["extracted"] += 1
            except Exception:
                r["failed"] += 1
        return r
