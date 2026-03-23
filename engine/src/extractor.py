import frida
import sys
import time
import json
import io
from pathlib import Path
from typing import Optional, Callable

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from .catalog_parser import CatalogParser
from .asset_extractor import AssetExtractor


GAME_PROCESS_NAME = "StarSavior.exe"
GAME_DATA_DIR = r"C:\Program Files (x86)\Steam\steamapps\common\StarSavior\Data"
BUNDLE_DIR = str(Path(GAME_DATA_DIR) / "eb")
CATALOG_PATH = str(Path(GAME_DATA_DIR) / "StreamingAssets" / "aa" / "catalog.json")
DEFAULT_OUTPUT_DIR = r"D:\starsavior-extractor\output"


class FridaExtractor:
    def __init__(self, output_dir: str = DEFAULT_OUTPUT_DIR):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.session: Optional[frida.core.Session] = None
        self.script: Optional[frida.core.Script] = None
        self.asset_extractor = AssetExtractor(str(self.output_dir))
        self.messages: list[dict] = []
        self.bundle_data: dict[str, bytes] = {}
        self.sqlite_rows: list[dict] = []
        self.unity_bundles_found: list[dict] = []
        self._on_message_callback: Optional[Callable] = None

    def attach(self, process_name: str = GAME_PROCESS_NAME) -> bool:
        try:
            device = frida.get_local_device()
            try:
                self.session = device.attach(process_name)
            except frida.ProcessNotFoundError:
                try:
                    self.session = device.attach(process_name.replace(".exe", ""))
                except frida.ProcessNotFoundError:
                    print(f"Process '{process_name}' not found. Is the game running?")
                    print("Available processes:")
                    for p in device.enumerate_processes():
                        if any(
                            kw in p.name.lower() for kw in ["star", "savior", "unity"]
                        ):
                            print(f"  PID {p.pid}: {p.name}")
                    return False

            print(f"Attached to {process_name} (PID {self.session._impl.pid})")
            return True
        except Exception as e:
            print(f"Failed to attach: {e}")
            return False

    def load_hooks(self, hooks_path: str | None = None) -> bool:
        if hooks_path is None:
            hooks_path = str(Path(__file__).parent.parent / "hooks" / "main.js")

        with open(hooks_path, "r", encoding="utf-8") as f:
            hook_source = f.read()

        assert self.session is not None
        try:
            self.script = self.session.create_script(hook_source)
            self.script.on("message", self._on_message)
            self.script.load()
            print("Frida hooks loaded")
            return True
        except Exception as e:
            print(f"Failed to load hooks: {e}")
            return False

    def _on_message(self, message, data):
        if message["type"] == "send":
            payload = message["payload"]
            msg_type = payload.get("type", "")

            if msg_type == "info":
                print(f"[Frida] {payload['message']}")
            elif msg_type == "error":
                print(f"[Frida Error] {payload['message']}")
            elif msg_type == "file_open":
                if payload["path"].endswith(".bundle"):
                    print(f"  [Open] {payload['path']}")
            elif msg_type == "file_read":
                path = payload["path"]
                if path.endswith(".bundle"):
                    flags = []
                    if payload.get("isUnityFS"):
                        flags.append("UnityFS")
                    if payload.get("isUnityRaw"):
                        flags.append("UnityRaw")
                    flag_str = f" [{', '.join(flags)}]" if flags else ""
                    print(
                        f"  [Read] {Path(path).name} +{payload['bytesRead']}b"
                        f" (total:{payload['totalRead']}){flag_str}"
                        f" hdr={payload.get('headerHex', '')}"
                    )
            elif msg_type == "file_seek":
                pass
            elif msg_type == "file_close":
                pass
            elif msg_type == "bundle_decrypted":
                path = payload["path"]
                name = Path(path).stem
                if name not in self.bundle_data or payload.get("totalRead", 0) > len(
                    self.bundle_data.get(name, b"")
                ):
                    if data:
                        self.bundle_data[name] = data
                        print(f"  [Captured] {name} ({len(data):,} bytes)")
            elif msg_type == "mmap_unity":
                print(
                    f"  [MMAP UnityFS] at {payload['address']} size={payload['size']}"
                )
            elif msg_type == "sqlite_exec":
                sql = payload.get("sql", "")
                if sql:
                    sql_lower = sql.lower().strip()
                    if not sql_lower.startswith("pragma") and not sql_lower.startswith(
                        "commit"
                    ):
                        print(f"  [SQLite] {sql[:120]}")
            elif msg_type == "sqlite_row":
                row = payload.get("row", {})
                self.sqlite_rows.append(row)
                keys = list(row.keys())
                if any(
                    k
                    for k in keys
                    if any(
                        t in k.lower()
                        for t in ["character", "hero", "unit", "stat", "skill"]
                    )
                ):
                    print(f"  [SQLite Row] {row}")
            elif msg_type == "memory_scan":
                count = payload.get("count", 0)
                results = payload.get("results", [])
                print(f"  [Memory Scan] Found {count} UnityFS headers")
                self.unity_bundles_found = results
                for r in results[:20]:
                    print(f"    {r['address']} ver={r['version']} size={r['size']}")
            elif msg_type == "unity_exports":
                count = payload.get("count", 0)
                exports = payload.get("exports", [])
                print(f"  [Unity Exports] {count} AssetBundle-related exports")
                for e in exports[:30]:
                    print(f"    {e}")
            elif msg_type == "memory_dump":
                print(f"  [Dump] {payload['address']} ({payload['size']} bytes)")
            else:
                line = f"  [{msg_type}] {json.dumps(payload, ensure_ascii=False)[:200]}"
                print(line)

        elif message["type"] == "error":
            print(f"[Script Error] {message.get('description', message)}")

    def scan_memory(self) -> list[dict]:
        if self.script:
            api = self.script.exports_sync
            api.scan_memory()
            time.sleep(2)
        return self.unity_bundles_found

    def dump_memory_region(self, address: str, size: int) -> Optional[bytes]:
        if self.script:
            api = self.script.exports_sync
            result = api.dump_memory(address, size)
            return result
        return None

    def extract_from_captured_bundles(self) -> int:
        total = 0
        for name, data in self.bundle_data.items():
            print(f"\nProcessing captured bundle: {name}...")
            assets = self.asset_extractor.extract_from_bytes(data, name)
            total += len(assets)
        print(f"\nTotal assets extracted from captured bundles: {total}")
        return total

    def extract_from_memory_bundles(self, max_bundles: int = 50) -> int:
        if not self.unity_bundles_found:
            print("No Unity bundles found in memory. Run scan_memory() first.")
            return 0

        total = 0
        for bundle_info in self.unity_bundles_found[:max_bundles]:
            addr = bundle_info["address"]
            size = bundle_info["size"]
            print(f"\nDumping memory at {addr} (size={size})...")

            data = self.dump_memory_region(addr, min(size, 100 * 1024 * 1024))
            if data and len(data) > 0:
                name = f"mem_{addr.replace('0x', '')}"
                assets = self.asset_extractor.extract_from_bytes(data, name)
                total += len(assets)

        print(f"\nTotal assets extracted from memory: {total}")
        return total

    def extract_from_builtin_assets(self) -> int:
        print("Extracting from built-in assets (resources.assets, sharedassets0)...")
        total = 0
        for fname in ["resources.assets", "sharedassets0.assets"]:
            path = str(Path(GAME_DATA_DIR) / fname)
            if Path(path).exists():
                print(f"\nProcessing {fname}...")
                assets = self.asset_extractor.extract_from_file(path)
                total += len(assets)
        print(f"\nTotal from built-in assets: {total}")
        return total

    def save_sqlite_data(self, filepath: str | None = None):
        if not self.sqlite_rows:
            print("No SQLite data captured yet.")
            return
        if filepath is None:
            filepath = str(self.output_dir / "sqlite_capture.json")
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(self.sqlite_rows, f, ensure_ascii=False, indent=2)
        print(f"Saved {len(self.sqlite_rows)} SQLite rows to {filepath}")

    def detach(self):
        if self.script:
            self.script.unload()
        if self.session:
            self.session.detach()
        print("Detached from process")


def find_game_process() -> Optional[str]:
    device = frida.get_local_device()
    for p in device.enumerate_processes():
        if p.name.lower() in ("starsavior.exe", "starsavior"):
            return p.name
    return None
