import json
import base64
import struct
from pathlib import Path
from typing import Optional


class CatalogParser:
    def __init__(self, catalog_path: str):
        self.catalog_path = Path(catalog_path)
        self._raw = None
        self._keys = []
        self._internal_ids = []
        self._bundle_infos = []

    def load(self):
        with open(self.catalog_path, "r", encoding="utf-8") as f:
            self._raw = json.load(f)
        self._parse_keys()
        self._parse_internal_ids()
        self._parse_bundle_infos()
        return self

    def _parse_keys(self):
        key_data = self._raw.get("m_KeyDataString", "")
        if not key_data:
            return
        decoded = base64.b64decode(key_data)
        pos = 4
        while pos < len(decoded):
            if pos + 4 > len(decoded):
                break
            length = int.from_bytes(decoded[pos : pos + 4], "little")
            pos += 4
            if pos + length > len(decoded):
                break
            chunk = decoded[pos : pos + length]
            pos += length
            parts = chunk.split(b"\x00")
            for part in parts:
                text = part.decode("utf-8", errors="replace").strip()
                if text and len(text) > 0:
                    self._keys.append(text)

    def _parse_internal_ids(self):
        self._internal_ids = self._raw.get("m_InternalIds", [])

    def _parse_bundle_infos(self):
        self._bundle_infos = self._raw.get("m_BundleInfos", [])

    def get_keys(self) -> list[str]:
        return self._keys

    def get_internal_ids(self) -> list[str]:
        return self._internal_ids

    def find_keys_containing(self, term: str) -> list[str]:
        term_lower = term.lower()
        return [k for k in self._keys if term_lower in k.lower()]

    def find_bundle_for_key(self, key: str) -> Optional[str]:
        if key in self._internal_ids:
            idx = self._internal_ids.index(key)
            if idx < len(self._bundle_infos):
                return self._bundle_infos[idx]
        return None

    def get_image_keys(self) -> list[str]:
        img_terms = [
            "img",
            "icon",
            "sprite",
            "portrait",
            "avatar",
            "thumb",
            "banner",
            "bg",
        ]
        return list(
            {
                k
                for k in self._keys
                if any(t in k.lower().split("/")[-1] for t in img_terms)
                if not k.startswith("{")
            }
        )

    def get_ui_keys(self) -> list[str]:
        return [k for k in self._keys if "ui_" in k.lower() or "/ui/" in k.lower()]

    def summary(self) -> dict:
        return {
            "total_keys": len(self._keys),
            "total_internal_ids": len(self._internal_ids),
            "total_bundle_infos": len(self._bundle_infos),
            "resource_types": len(self._raw.get("m_resourceTypes", [])),
            "provider_ids": self._raw.get("m_ProviderIds", []),
        }
