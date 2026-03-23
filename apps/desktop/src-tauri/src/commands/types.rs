use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDefaults {
    pub workspace_root: String,
    pub game_path: String,
    pub output_dir: String,
    pub decrypted_dir: String,
    pub templets_dir: String,
    pub textures_dir: String,
    pub sprites_dir: String,
}

pub fn get_defaults() -> AppDefaults {
    let workspace = PathBuf::from(r"D:\starsavior-extractor-app\engine");
    let output = PathBuf::from(r"D:\starsavior-extractor\output");

    AppDefaults {
        workspace_root: workspace.to_string_lossy().to_string(),
        game_path: r"C:\Program Files (x86)\Steam\steamapps\common\StarSavior".to_string(),
        output_dir: output.to_string_lossy().to_string(),
        decrypted_dir: output.join("decrypted").to_string_lossy().to_string(),
        templets_dir: output
            .join("decrypted_templets")
            .to_string_lossy()
            .to_string(),
        textures_dir: output.join("textures").to_string_lossy().to_string(),
        sprites_dir: output.join("sprites").to_string_lossy().to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionState {
    pub running: bool,
    pub status: String,
}
