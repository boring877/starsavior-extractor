export interface AppDefaults {
  workspaceRoot: string;
  gamePath: string;
  outputDir: string;
  decryptedDir: string;
  templetsDir: string;
  texturesDir: string;
  spritesDir: string;
}

export interface EngineResult {
  ok: boolean;
  exitCode?: number;
  error?: string;
}

export interface ExtractionState {
  running: boolean;
  status: string;
}
