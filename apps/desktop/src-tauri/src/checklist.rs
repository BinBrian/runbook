use crate::{with_store, AppState};
use runbook_checklist::{
    archive::{ExportData, ImportPreview},
    validate, Action, Workspace,
};
use serde::Serialize;
use std::io::{Read, Write};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn checklist_load(state: State<'_, AppState>) -> Result<Workspace, String> {
    with_store(&state, |s| s.workspace()).await
}
#[tauri::command]
pub async fn checklist_load_work(state: State<'_, AppState>) -> Result<runbook_checklist::WorkLoad, String> {
    with_store(&state, |s| s.work_workspace()).await
}
#[tauri::command]
pub async fn checklist_apply(
    state: State<'_, AppState>,
    action: Action,
) -> Result<Workspace, String> {
    with_store(&state, move |s| s.apply(action)).await
}
#[tauri::command]
pub async fn checklist_preview_import(
    state: State<'_, AppState>,
    name: String,
    bytes: Vec<u8>,
) -> Result<ImportPreview, String> {
    with_store(&state, move |s| s.preview_work_import(&name, &bytes)).await
}
#[tauri::command]
pub async fn checklist_commit_import(
    state: State<'_, AppState>,
    token: String,
    as_copy: bool,
) -> Result<Workspace, String> {
    with_store(&state, move |s| s.commit_import(&token, as_copy)).await
}
#[tauri::command]
pub async fn checklist_export_data(
    state: State<'_, AppState>,
    kind: String,
    id: String,
) -> Result<ExportData, String> {
    with_store(&state, move |s| s.export_data(&kind, &id)).await
}
#[tauri::command]
pub async fn checklist_attach_image(
    state: State<'_, AppState>,
    instance_id: String,
    step_id: String,
    name: String,
    media_type: String,
    bytes: Vec<u8>,
) -> Result<Workspace, String> {
    with_store(&state, move |s| {
        s.attach_image(&instance_id, &step_id, &name, &media_type, &bytes)
    })
    .await
}
#[tauri::command]
pub async fn checklist_read_image(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<String, String> {
    with_store(&state, move |s| s.read_image(&instance_id, &path)).await
}

#[derive(Serialize)]
pub struct ImportFile {
    name: String,
    bytes: Vec<u8>,
}
#[tauri::command]
pub async fn checklist_pick_import(app: tauri::AppHandle) -> Result<Option<ImportFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Runbook 工作记录或步骤块", &["json", "zip"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        validate::ensure(
            file.metadata().map_err(|e| e.to_string())?.len() <= validate::MAX_FILE as u64,
            "导入文件超过 32 MiB",
        )?;
        let mut bytes = Vec::new();
        file.take((validate::MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        validate::ensure(bytes.len() <= validate::MAX_FILE, "导入文件超过 32 MiB")?;
        Ok(Some(ImportFile {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            bytes,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn checklist_save_export(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    validate::ensure(bytes.len() <= validate::MAX_FILE, "导出文件超过 32 MiB")?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name(runbook_checklist::archive::safe_name(&name))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        let parent = path.parent().ok_or("无效导出路径")?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&path).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
