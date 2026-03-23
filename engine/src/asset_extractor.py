import io
import os
import UnityPy
from PIL import Image
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.0.61f1"


@dataclass
class ExtractedAsset:
    name: str
    asset_type: str
    container: str = ""
    path_id: int = 0
    width: int = 0
    height: int = 0
    data: bytes = b""
    save_path: str = ""


class AssetExtractor:
    def __init__(self, output_dir: str):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def extract_from_bytes(
        self, data: bytes, bundle_name: str = "unknown"
    ) -> list[ExtractedAsset]:
        assets = []
        try:
            env = UnityPy.load(io.BytesIO(data))
            assets = self._extract_all(env, bundle_name)
        except Exception as e:
            print(f"  Failed to parse {bundle_name}: {e}")
        return assets

    def extract_from_file(self, file_path: str) -> list[ExtractedAsset]:
        assets = []
        try:
            env = UnityPy.load(file_path)
            name = Path(file_path).stem
            assets = self._extract_all(env, name)
        except Exception as e:
            print(f"  Failed to parse {file_path}: {e}")
        return assets

    def _extract_all(self, env, source_name: str) -> list[ExtractedAsset]:
        assets = []
        extracted = {"Texture2D": 0, "Sprite": 0, "TextAsset": 0, "AudioClip": 0}

        for obj in env.objects:
            try:
                if obj.type.name == "Texture2D":
                    asset = self._extract_texture(obj, source_name)
                    if asset:
                        assets.append(asset)
                        extracted["Texture2D"] += 1
                elif obj.type.name == "Sprite":
                    asset = self._extract_sprite(obj, source_name)
                    if asset:
                        assets.append(asset)
                        extracted["Sprite"] += 1
                elif obj.type.name == "TextAsset":
                    asset = self._extract_text(obj, source_name)
                    if asset:
                        assets.append(asset)
                        extracted["TextAsset"] += 1
                elif obj.type.name == "AudioClip":
                    asset = self._extract_audio(obj, source_name)
                    if asset:
                        assets.append(asset)
                        extracted["AudioClip"] += 1
            except Exception as e:
                pass

        if any(v > 0 for v in extracted.values()):
            parts = [f"{k}:{v}" for k, v in extracted.items() if v > 0]
            print(f"  [{source_name}] Extracted: {', '.join(parts)}")

        return assets

    def _extract_texture(self, obj, source_name: str) -> Optional[ExtractedAsset]:
        data = obj.read()
        try:
            img = data.image
            if img:
                name = data.m_Name or f"tex_{data.path_id}"
                safe_name = self._safe_filename(name)
                save_dir = self.output_dir / "textures" / source_name
                save_dir.mkdir(parents=True, exist_ok=True)
                save_path = save_dir / f"{safe_name}.png"
                img.save(str(save_path))
                return ExtractedAsset(
                    name=name,
                    asset_type="Texture2D",
                    container=obj.container or "",
                    path_id=data.path_id,
                    width=data.m_Width,
                    height=data.m_Height,
                    save_path=str(save_path),
                )
        except Exception:
            pass
        return None

    def _extract_sprite(self, obj, source_name: str) -> Optional[ExtractedAsset]:
        data = obj.read()
        try:
            img = data.image
            if img:
                name = data.m_Name or f"spr_{data.path_id}"
                safe_name = self._safe_filename(name)
                save_dir = self.output_dir / "sprites" / source_name
                save_dir.mkdir(parents=True, exist_ok=True)
                save_path = save_dir / f"{safe_name}.png"
                img.save(str(save_path))
                return ExtractedAsset(
                    name=name,
                    asset_type="Sprite",
                    container=obj.container or "",
                    path_id=data.path_id,
                    width=img.width,
                    height=img.height,
                    save_path=str(save_path),
                )
        except Exception:
            pass
        return None

    def _extract_text(self, obj, source_name: str) -> Optional[ExtractedAsset]:
        data = obj.read()
        text = data.m_Script
        if not text or len(text) < 2:
            return None
        name = data.m_Name or f"text_{data.path_id}"
        safe_name = self._safe_filename(name)
        save_dir = self.output_dir / "text_assets" / source_name
        save_dir.mkdir(parents=True, exist_ok=True)

        if self._is_json(text):
            save_path = save_dir / f"{safe_name}.json"
            with open(save_path, "w", encoding="utf-8") as f:
                f.write(text)
        elif self._is_printable(text):
            save_path = save_dir / f"{safe_name}.txt"
            with open(save_path, "w", encoding="utf-8", errors="replace") as f:
                f.write(text)
        else:
            save_path = save_dir / f"{safe_name}.bytes"
            with open(save_path, "wb") as f:
                if isinstance(text, str):
                    f.write(text.encode("utf-8", errors="replace"))
                else:
                    f.write(text)

        return ExtractedAsset(
            name=name,
            asset_type="TextAsset",
            container=obj.container or "",
            path_id=data.path_id,
            data=text.encode("utf-8", errors="replace")
            if isinstance(text, str)
            else text,
            save_path=str(save_path),
        )

    def _extract_audio(self, obj, source_name: str) -> Optional[ExtractedAsset]:
        data = obj.read()
        try:
            samples = data.samples
            if samples and len(samples) > 0:
                name = data.m_Name or f"audio_{data.path_id}"
                safe_name = self._safe_filename(name)
                save_dir = self.output_dir / "audio" / source_name
                save_dir.mkdir(parents=True, exist_ok=True)
                save_path = save_dir / f"{safe_name}.wav"
                samples.export(str(save_path), format="WAV")
                return ExtractedAsset(
                    name=name,
                    asset_type="AudioClip",
                    container=obj.container or "",
                    path_id=data.path_id,
                    save_path=str(save_path),
                )
        except Exception:
            pass
        return None

    @staticmethod
    def _safe_filename(name: str) -> str:
        for ch in r'<>:"/\|?*':
            name = name.replace(ch, "_")
        return name.strip(". ")

    @staticmethod
    def _is_json(text: str) -> bool:
        text = text.strip()
        return (text.startswith("{") and text.endswith("}")) or (
            text.startswith("[") and text.endswith("]")
        )

    @staticmethod
    def _is_printable(text: str) -> bool:
        if isinstance(text, bytes):
            return False
        return sum(1 for c in text if c.isprintable()) / max(len(text), 1) > 0.85
