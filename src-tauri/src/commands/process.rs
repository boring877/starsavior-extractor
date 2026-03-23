use crate::commands::state::ActiveProcess;
use crate::commands::types::ExtractionState;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};

pub fn spawn_command(
    cmd: &str,
    args: &[&str],
    cwd: &str,
) -> Result<SpawnResult, String> {
    let child = tokio::process::Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .env("PYTHONUNBUFFERED", "1")
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let mut child = child;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    Ok(SpawnResult {
        stdout,
        stderr,
        child,
    })
}

pub struct SpawnResult {
    pub stdout: Option<tokio::process::ChildStdout>,
    pub stderr: Option<tokio::process::ChildStderr>,
    pub child: tokio::process::Child,
}

pub fn stream_output(
    app: &AppHandle,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    err_prefix: &str,
) {
    if let Some(stdout) = stdout {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    let _ = app_clone.emit("extract:log", trimmed);
                }
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_clone = app.clone();
        let prefix = err_prefix.to_string();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    let _ = app_clone.emit("extract:log", format!("{}{}", prefix, trimmed));
                }
            }
        });
    }
}

pub fn store_and_wait(
    state: &tauri::State<'_, ActiveProcess>,
    child: tokio::process::Child,
    app: &AppHandle,
    on_complete: Option<String>,
) {
    *state.0.lock().unwrap() = Some(crate::commands::state::RunningProcess { child });

    let state_arc = state.0.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        loop {
            let taken = {
                let mut guard = state_arc.lock().unwrap();
                if guard.is_none() {
                    true
                } else if let Some(ref mut running) = *guard {
                    match running.child.try_wait() {
                        Ok(Some(_)) => {
                            guard.take();
                            true
                        }
                        Ok(None) => false,
                        Err(_) => {
                            guard.take();
                            true
                        }
                    }
                } else {
                    true
                }
            };
            if taken {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        if let Some(msg) = on_complete {
            let _ = app_clone.emit("extract:log", msg);
        }
        let _ = app_clone.emit(
            "extract:state",
            ExtractionState {
                running: false,
                status: "Idle".to_string(),
            },
        );
    });
}

pub fn emit_error(app: &AppHandle, msg: &str) {
    emit_state(app, false, "Idle");
    let _ = app.emit("extract:log", format!("ERROR: {}", msg));
}

pub fn emit_state(app: &AppHandle, running: bool, status: &str) {
    let _ = app.emit(
        "extract:state",
        ExtractionState {
            running,
            status: status.to_string(),
        },
    );
}
