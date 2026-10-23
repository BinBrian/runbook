use std::sync::{Arc, Mutex};
use tauri::Manager;
mod checklist;
mod data_path;
mod startup;

#[derive(Clone)]
pub(crate) struct AppState(Arc<Mutex<runbook_checklist::Store>>);

pub(crate) async fn with_store<T: Send + 'static>(
    state: &AppState,
    action: impl FnOnce(&mut runbook_checklist::Store) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = shared
            .lock()
            .map_err(|_| "本地数据库锁已损坏，请重启应用".to_string())?;
        action(&mut store)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn initialize_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let directory = data_path::resolve(
        &std::env::current_exe()?,
        std::env::var_os("RUNBOOK_DATA_DIR"),
        || app.path().app_local_data_dir().map_err(|e| e.to_string()),
    )
    .map_err(std::io::Error::other)?;
    startup::record(&format!("Data directory: {}", directory.display()));
    std::fs::create_dir_all(&directory).map_err(|e| {
        std::io::Error::other(format!("无法创建本地数据目录 {}：{e}", directory.display()))
    })?;
    startup::record("Opening independent checklist SQLite database");
    let store = runbook_checklist::Store::open(&directory).map_err(std::io::Error::other)?;
    app.manage(AppState(Arc::new(Mutex::new(store))));
    startup::record("Creating main window and WebView2");
    tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
        .data_directory(directory.join("webview"))
        .build()
        .map_err(|e| std::io::Error::other(format!("无法创建主窗口（WebView2）：{e}")))?;
    startup::record("Main window created");
    Ok(())
}

pub fn run() {
    startup::install();
    let mut builder = tauri::Builder::default();
    // A test with an explicit isolated directory must never activate a real running app.
    if std::env::var_os("RUNBOOK_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            startup::record("Another instance requested activation");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let result = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(error) = initialize_desktop(app) {
                startup::report_failure(&error.to_string());
                app.handle().exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            checklist::checklist_load,
            checklist::checklist_load_work,
            checklist::checklist_apply,
            checklist::checklist_pick_import,
            checklist::checklist_preview_import,
            checklist::checklist_commit_import,
            checklist::checklist_export_data,
            checklist::checklist_save_export,
            checklist::checklist_attach_image,
            checklist::checklist_read_image,
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        startup::report_failure(&format!("桌面运行时启动失败：{error}"));
        std::process::exit(1);
    }
}
