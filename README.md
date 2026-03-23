# Star Savior Extractor

Desktop app and Python engine for extracting game data from **Star Savior** (Unity 6 Mono).

## Overview

Star Savior uses Unity 6 with encrypted `.bundle` files and an inner templet encryption layer on game data tables. This toolchain handles:

1. **Bundle Decryption** -- XOR-decrypt 1,899 encrypted bundles from `Data/eb/`
2. **Templet Decryption** -- Decrypt inner `.bytes` TextAsset files (game data tables) with MD5-based XOR mask + LZ4 decompression
3. **Asset Extraction** -- Extract textures, sprites, and other assets via UnityPy

## Encryption Details

### Bundle Encryption
- 16-byte repeating XOR key derived per bundle
- Key derivation: `MD5(first_32_chars_of_filename + ".bytes")` -> 16-byte mask
- XOR applied to first 102,400 bytes
- Some bundles use a "Type 1" fixed key (`0xFFBBCC21` repeating, 128-byte limit)
- Compressed blocks may have an additional PartialBitBlend layer

### Templet Encryption (Inner Layer)
- 4-byte magic: `0x2B21DE00 + version_byte`
- Version 0/1: LZ4 compressed JSON
- Version 2: MD5-based XOR mask (`MD5(filename + ".bytes")`) applied to LZ4-framed data, then decompressed
- Raw bytes must be read directly via `obj.get_raw_data()` -- UnityPy corrupts binary TextAsset data when reading as string

## Project Structure

```
src/                  # React 19 frontend (Tauri v2 app)
  api/                # Desktop API bridge and types
  hooks/              # React hooks for extraction state
src-tauri/            # Rust backend (Tauri commands)
  src/commands/       # Tauri command handlers (decrypt, extract, process)
engine/               # Python extraction engine
  src/
    bundle_decryptor.py    # Bundle XOR decryption + block parsing
    asset_extractor.py     # UnityPy-based asset extraction
    catalog_parser.py      # Unity catalog.json parser
    extractor.py           # Frida-based live extraction
  hooks/                   # Frida JavaScript hooks (22 files)
    main.js                # Primary Mono heap scan hook
    hook_bitblend.js       # PartialBitBlend stream capture
    hook_filename.js       # FileNameMasking/MD5 key capture
    hook_banner_dates.js   # Gacha schedule/banner date extraction
    equip_substats.js      # Equipment substat hook (WIP)
    ...
  decrypt_templets_v2.py   # Standalone templet decryption script
  main.py                  # CLI entry point with all subcommands
```

## Desktop App

Built with Tauri v2 + React 19 + TypeScript.

```bash
npm install
npx tauri dev    # dev mode
npx tauri build  # production build
```

## Python Engine CLI

```bash
cd engine
pip install -r requirements.txt

# Check game/catalog status
python main.py status

# Decrypt all bundles (1,899 files from Data/eb/)
python main.py decrypt

# Decrypt + extract assets in one pass
python main.py decrypt-extract

# Decrypt templets (game data tables) from decrypted bundles
python decrypt_templets_v2.py

# Search catalog for keys
python main.py catalog --search "icon"
```

### Frida Commands (game must be running)

```bash
# Live Mono heap extraction
python main.py extract --process StarSavior.exe

# Scan GC handle types
python main.py scan-types --process StarSavior.exe

# Hook PartialBitBlend stream
python main.py hook-bitblend --process StarSavior.exe

# Hook filename masking / MD5 key derivation
python main.py hook-filename --process StarSavior.exe

# Extract gacha banner dates
python main.py hook-banner-dates --process StarSavior.exe
```

## Extraction Results

- **1,899 / 1,899** bundles decrypted successfully
- **2,156** templet files decrypted (167 MB) -- character stats, skills, equipment, localization (14 languages), etc.
- **Textures**: UI atlases, skill icons, stat bar images
- **Sprites**: UI buttons, frames, popup elements

## Requirements

- Python 3.10+ with `frida`, `UnityPy`, `Pillow`, `lz4`, `numpy`
- Node.js 20+ and Rust toolchain for the desktop app
- Star Savior installed (default: `C:\Program Files (x86)\Steam\steamapps\common\StarSavior\`)

## Notes

- Frida's standard `Mono`/`Il2Cpp` APIs are not available with this game's embedded Mono runtime. Only raw memory scanning via `Process.enumerateModules()` works. The hooks use direct pointer manipulation instead.
- Equipment substat exact values are server-side only and not available in client templet files.
- Some NPC arcana card images (Lisa, Lisette) are missing from extracted textures.
