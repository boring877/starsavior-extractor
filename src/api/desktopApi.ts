import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppDefaults, EngineResult, ExtractionState } from "./types";

export async function getDefaults(): Promise<AppDefaults> {
  return invoke("app_get_defaults");
}

export async function runDecryptBundles(force: boolean): Promise<EngineResult> {
  return invoke("run_decrypt_bundles", { force });
}

export async function runDecryptTemplets(): Promise<EngineResult> {
  return invoke("run_decrypt_templets");
}

export async function runExtractImages(force: boolean): Promise<EngineResult> {
  return invoke("run_extract_images", { force });
}

export async function stopProcess(): Promise<EngineResult> {
  return invoke("process_stop");
}

export function subscribeLogs(handler: (line: string) => void): Promise<() => void> {
  return listen<string>("extract:log", (e) => handler(e.payload));
}

export function subscribeState(handler: (state: ExtractionState) => void): Promise<() => void> {
  return listen<ExtractionState>("extract:state", (e) => handler(e.payload));
}
