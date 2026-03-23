use crate::commands::state::ActiveProcess;
use crate::commands::types::{AppDefaults, EngineResult};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempletEntry {
    name: String,
    size: u64,
}

#[tauri::command]
pub fn list_templets() -> Vec<TempletEntry> {
    let d = crate::commands::types::get_defaults();
    let dir = PathBuf::from(&d.templets_dir);
    if !dir.exists() {
        return vec![];
    }
    let mut entries: Vec<TempletEntry> = std::fs::read_dir(&dir)
        .ok()
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().map(|ext| ext == "json").unwrap_or(false))
                .map(|e| TempletEntry {
                    name: e.path().file_stem().unwrap_or_default().to_string_lossy().to_string(),
                    size: e.metadata().map(|m| m.len()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| b.size.cmp(&a.size));
    entries
}

#[tauri::command]
pub fn app_get_defaults() -> AppDefaults {
    crate::commands::types::get_defaults()
}

#[tauri::command]
pub async fn run_decrypt_bundles(
    app: AppHandle,
    state: State<'_, ActiveProcess>,
    force: bool,
) -> Result<EngineResult, String> {
    if state.0.lock().unwrap().is_some() {
        return Ok(already_running());
    }
    let d = crate::commands::types::get_defaults();
    let script = PathBuf::from(&d.workspace_root).join("main.py").to_string_lossy().to_string();
    let mut args = vec!["decrypt-extract".to_string(), "--output".to_string(), d.output_dir.clone()];
    if force { args.push("--force".to_string()); }
    run_python(app, state, script, args, "Decrypting bundles...").await
}

#[tauri::command]
pub async fn run_decrypt_templets(
    app: AppHandle,
    state: State<'_, ActiveProcess>,
) -> Result<EngineResult, String> {
    if state.0.lock().unwrap().is_some() {
        return Ok(already_running());
    }
    let d = crate::commands::types::get_defaults();
    let script = PathBuf::from(&d.workspace_root).join("decrypt_templets_v2.py").to_string_lossy().to_string();
    run_python(app, state, script, vec![], "Decrypting templets...").await
}

#[tauri::command]
pub async fn run_extract_images(
    app: AppHandle,
    state: State<'_, ActiveProcess>,
    force: bool,
) -> Result<EngineResult, String> {
    if state.0.lock().unwrap().is_some() {
        return Ok(already_running());
    }
    let d = crate::commands::types::get_defaults();
    let script = PathBuf::from(&d.workspace_root).join("main.py").to_string_lossy().to_string();
    let mut args = vec![
        "extract-decrypted".to_string(),
        "--output".to_string(),
        d.output_dir.clone(),
        "--decrypted-dir".to_string(),
        d.decrypted_dir.clone(),
    ];
    if force { args.push("--force".to_string()); }
    run_python(app, state, script, args, "Extracting images...").await
}

#[tauri::command]
pub async fn process_stop(
    state: State<'_, ActiveProcess>,
) -> Result<EngineResult, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut running) = *guard {
        let _ = running.child.start_kill();
        *guard = None;
        Ok(EngineResult { ok: true, exit_code: None, error: None })
    } else {
        Ok(EngineResult { ok: false, exit_code: None, error: Some("No process running".into()) })
    }
}

fn already_running() -> EngineResult {
    EngineResult {
        ok: false,
        exit_code: None,
        error: Some("Another process is already running.".into()),
    }
}

pub async fn run_python(
    app: AppHandle,
    state: State<'_, ActiveProcess>,
    script: String,
    args: Vec<String>,
    label: &str,
) -> Result<EngineResult, String> {
    let python = std::env::var("PYTHON_EXE").unwrap_or_else(|_| "python".to_string());
    let defaults = crate::commands::types::get_defaults();

    let mut full_args = vec!["-u".to_string(), script];
    full_args.extend(args);

    let cmd_str = format!("{} {}", python, full_args.join(" "));
    let _ = app.emit("extract:log", cmd_str);
    crate::commands::process::emit_state(&app, true, label);

    let args_refs: Vec<&str> = full_args.iter().map(|s| s.as_str()).collect();

    match crate::commands::process::spawn_command(&python, &args_refs, &defaults.workspace_root) {
        Ok(result) => {
            crate::commands::process::stream_output(&app, result.stdout, result.stderr, "ERR: ");
            crate::commands::process::store_and_wait(&state, result.child, &app, None);
            Ok(EngineResult { ok: true, exit_code: None, error: None })
        }
        Err(e) => {
            crate::commands::process::emit_error(&app, &e);
            Ok(EngineResult { ok: false, error: Some(e), exit_code: None })
        }
    }
}
