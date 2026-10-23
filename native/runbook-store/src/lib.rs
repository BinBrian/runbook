//! Transactional local persistence and the sole mutation boundary for Runbook.
//! Commands recorded in a document are data: this crate has no process execution API.
mod request;
pub use request::{Action, Request};

use chrono::{SecondsFormat, Utc};
use runbook_core::*;
use rusqlite::{params, Connection, DatabaseName, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    time::Duration,
};
use uuid::Uuid;

const MAX_IMPORT_BYTES: usize = 32 * 1024 * 1024;
const SCHEMA_VERSION: i32 = 2;

pub struct Store {
    connection: Connection,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|e| format!("数据格式无效：{e}"))
}
fn uuid(id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "ID 必须是 UUID")?;
    if parsed.to_string() != id {
        return Err("ID 必须是标准小写 UUID".into());
    }
    Ok(())
}
fn name(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err("名称不能为空".into())
    } else {
        Ok(())
    }
}
fn revision(actual: u32, expected: Option<u32>) -> Result<(), String> {
    if expected == Some(actual) {
        Ok(())
    } else {
        Err(format!(
            "版本冲突：当前版本 {actual}，请保留编辑内容并重新载入"
        ))
    }
}
fn increment(value: u32) -> Result<u32, String> {
    value.checked_add(1).ok_or_else(|| "版本已达到上限".into())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| format!("无法打开数据库：{e}"))?;
        Self::initialize(connection, Some(path))
    }

    pub fn memory() -> Result<Self, String> {
        Self::initialize(
            Connection::open_in_memory().map_err(|e| e.to_string())?,
            None,
        )
    }

    fn initialize(mut connection: Connection, path: Option<&Path>) -> Result<Self, String> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "数据库版本 {version} 高于本应用支持的版本 {SCHEMA_VERSION}，请使用较新版本打开"
            ));
        }
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
            )
            .map_err(|e| e.to_string())?;
        if version == 0 {
            let tx = connection.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(include_str!("schema.sql"))
                .map_err(|e| e.to_string())?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        } else if version == 1 {
            let path = path.ok_or("旧数据库缺少可备份的文件路径，升级已停止")?;
            let filename = path.file_name().ok_or("数据库路径无效")?.to_string_lossy();
            let backup = path.with_file_name(format!(
                "{filename}.schema1-backup-{}.sqlite3",
                Uuid::new_v4()
            ));
            // The SQLite backup API copies a consistent snapshot including WAL;
            // copying the main database file alone could silently omit commits.
            connection
                .backup(DatabaseName::Main, &backup, None)
                .map_err(|e| format!("升级前一致性备份失败，原数据库未升级：{e}"))?;
            let tx = connection.transaction().map_err(|e| e.to_string())?;
            let workspace = load(&tx)?;
            validate_workspace(&workspace)
                .map_err(|e| format!("旧数据库校验失败，原数据与备份已保留：{e}"))?;
            validate_import_metadata(&workspace)?;
            // Schema 2 adds fields inside payloads. Serde supplies empty maps for
            // old records; leave all original payload bytes and receipts intact.
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        let workspace = load(&connection)?;
        validate_workspace(&workspace).map_err(|e| format!("本地数据库记录校验失败：{e}"))?;
        validate_import_metadata(&workspace)?;
        Ok(Self { connection })
    }

    pub fn workspace(&self) -> Result<Workspace, String> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let workspace = load(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(workspace)
    }

    pub fn export(&self) -> Result<String, String> {
        let workspace = self.workspace()?;
        let backup = Backup {
            format: "runbook-backup".into(),
            schema_version: 2,
            exported_at: now(),
            templates: workspace.templates,
            runs: workspace.runs,
        };
        serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())
    }

    pub fn perform(&mut self, request: Request) -> Result<Workspace, String> {
        uuid(&request.operation_id)?;
        let fingerprint = source_hash(&json(&request.action)?);
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        // Receipt lookup precedes revision validation, including after app restart.
        let receipt: Option<String> = tx
            .query_row(
                "SELECT request_hash FROM operation_receipts WHERE operation_id=?1",
                [&request.operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(previous) = receipt {
            if previous != fingerprint {
                return Err("此操作 ID 已用于不同请求，已拒绝重复使用".into());
            }
            // The business effect is already committed. Return current data so
            // a late transport retry cannot replace newer UI state with history.
            return load(&tx);
        }
        let mut workspace = load(&tx)?;
        let mut origins = HashMap::new();
        dispatch(&mut workspace, &request, &mut origins)?;
        persist(&tx, &workspace, &request.operation_id, &origins)?;
        let result = operation_result(&request.action, &workspace, &origins);
        tx.execute("INSERT INTO operation_receipts(operation_id,request_hash,result_json,created_at) VALUES(?1,?2,?3,?4)", params![request.operation_id, fingerprint, result.to_string(), now()]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| format!("保存失败：{e}"))?;
        Ok(workspace)
    }
}

fn operation_result(
    action: &Action,
    workspace: &Workspace,
    origins: &HashMap<String, String>,
) -> serde_json::Value {
    let object_id = match action {
        Action::CreateTemplate { id, .. }
        | Action::SaveTemplate { id, .. }
        | Action::ArchiveTemplate { id, .. }
        | Action::CreateRun { id, .. }
        | Action::SaveRunDraft { id, .. }
        | Action::ApplyRunDraft { id }
        | Action::DiscardRunDraft { id }
        | Action::SetSelectedStep { id, .. }
        | Action::UpdateRun { id, .. }
        | Action::CloseRun { id, .. } => Some(id),
        Action::BeginAttempt { run_id, .. }
        | Action::SaveAttempt { run_id, .. }
        | Action::FinishAttempt { run_id, .. }
        | Action::AnnotateAttempt { run_id, .. } => Some(run_id),
        Action::ImportBundle { .. } => None,
    };
    if let Some(id) = object_id {
        let revision = workspace
            .templates
            .iter()
            .find(|item| &item.id == id)
            .map(|item| item.revision)
            .or_else(|| {
                workspace
                    .runs
                    .iter()
                    .find(|item| &item.id == id)
                    .map(|item| item.revision)
            });
        serde_json::json!({ "object_id": id, "committed_revision": revision })
    } else {
        let mut ids: Vec<_> = origins.keys().collect();
        ids.sort();
        serde_json::json!({ "imported_ids": ids })
    }
}

fn load(connection: &Connection) -> Result<Workspace, String> {
    fn list<T: DeserializeOwned>(connection: &Connection, sql: &str) -> Result<Vec<T>, String> {
        let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|value| decode(&value.map_err(|e| e.to_string())?))
            .collect()
    }
    let templates = list(
        connection,
        "SELECT payload FROM templates ORDER BY created_at,id",
    )?;
    let mut runs: Vec<Run> = list(
        connection,
        "SELECT payload FROM runs ORDER BY created_at,id",
    )?;
    for run in &mut runs {
        let mut statement = connection
            .prepare("SELECT payload FROM run_steps WHERE run_id=?1 ORDER BY position,step_id")
            .map_err(|e| e.to_string())?;
        let values = statement
            .query_map([&run.id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        run.steps = values
            .map(|value| decode(&value.map_err(|e| e.to_string())?))
            .collect::<Result<_, _>>()?;
        for step in &mut run.steps {
            let mut statement = connection.prepare("SELECT payload FROM step_attempts WHERE run_id=?1 AND step_id=?2 ORDER BY attempt_no").map_err(|e| e.to_string())?;
            let values = statement
                .query_map(params![run.id, step.step_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            step.attempts = values
                .map(|value| decode(&value.map_err(|e| e.to_string())?))
                .collect::<Result<_, _>>()?;
            for attempt in &mut step.attempts {
                let mut statement = connection.prepare("SELECT payload FROM attempt_annotations WHERE attempt_id=?1 ORDER BY sequence").map_err(|e| e.to_string())?;
                let values = statement
                    .query_map([&attempt.id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                attempt.annotations = values
                    .map(|value| decode(&value.map_err(|e| e.to_string())?))
                    .collect::<Result<_, _>>()?;
            }
        }
    }
    Ok(Workspace { templates, runs })
}

fn persist(
    tx: &Transaction<'_>,
    workspace: &Workspace,
    operation_id: &str,
    origins: &HashMap<String, String>,
) -> Result<(), String> {
    for template in &workspace.templates {
        tx.execute("INSERT INTO templates(id,revision,created_at,updated_at,payload,import_source_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,payload=excluded.payload", params![template.id, template.revision, template.created_at, template.updated_at, json(template)?, origins.get(&template.id)]).map_err(|e| e.to_string())?;
    }
    for run in &workspace.runs {
        let mut head = run.clone();
        head.steps.clear();
        tx.execute("INSERT INTO runs(id,source_template_id,revision,created_at,updated_at,closed_at,payload,import_source_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,closed_at=excluded.closed_at,payload=excluded.payload", params![run.id, run.source_template_id, run.revision, run.created_at, run.updated_at, run.closed_at, json(&head)?, origins.get(&run.id)]).map_err(|e| e.to_string())?;
        for step in &run.steps {
            let mut head = step.clone();
            head.attempts.clear();
            tx.execute("INSERT INTO run_steps(run_id,step_id,position,content_version,present,payload) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(run_id,step_id) DO UPDATE SET position=excluded.position,content_version=excluded.content_version,present=excluded.present,payload=excluded.payload", params![run.id, step.step_id, step.position, step.content_version, step.present, json(&head)?]).map_err(|e| e.to_string())?;
            for attempt in &step.attempts {
                let mut head = attempt.clone();
                head.annotations.clear();
                tx.execute("INSERT INTO step_attempts(id,run_id,step_id,attempt_no,outcome,payload,operation_id,import_source_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,payload=excluded.payload", params![attempt.id, run.id, step.step_id, attempt.attempt_no, outcome_text(attempt.outcome), json(&head)?, operation_id, origins.get(&attempt.id)]).map_err(|e| e.to_string())?;
                for (index, annotation) in attempt.annotations.iter().enumerate() {
                    tx.execute("INSERT INTO attempt_annotations(id,attempt_id,sequence,payload,operation_id,import_source_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING", params![annotation.id, attempt.id, index as i64 + 1, json(annotation)?, operation_id, origins.get(&annotation.id)]).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

fn outcome_text(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Draft => "draft",
        Outcome::Completed => "completed",
        Outcome::Failed => "failed",
        Outcome::Skipped => "skipped",
        Outcome::Withdrawn => "withdrawn",
    }
}

fn template_mut<'a>(
    workspace: &'a mut Workspace,
    id: &str,
    expected: Option<u32>,
) -> Result<&'a mut Template, String> {
    let template = workspace
        .templates
        .iter_mut()
        .find(|template| template.id == id)
        .ok_or("模板不存在")?;
    revision(template.revision, expected)?;
    template.revision = increment(template.revision)?;
    template.updated_at = now();
    Ok(template)
}

fn run_mut<'a>(
    workspace: &'a mut Workspace,
    id: &str,
    expected: Option<u32>,
) -> Result<&'a mut Run, String> {
    let run = workspace
        .runs
        .iter_mut()
        .find(|run| run.id == id)
        .ok_or("执行实例不存在")?;
    revision(run.revision, expected)?;
    if run.closed_at.is_some() {
        return Err("已留档实例只读，请创建独立新实例继续记录".into());
    }
    run.revision = increment(run.revision)?;
    run.updated_at = now();
    Ok(run)
}

fn step_mut<'a>(run: &'a mut Run, id: &str) -> Result<&'a mut RunStep, String> {
    run.steps
        .iter_mut()
        .find(|step| step.step_id == id && step.present)
        .ok_or_else(|| "步骤不在当前流程中".into())
}

fn id_unused(workspace: &Workspace, id: &str) -> Result<(), String> {
    uuid(id)?;
    if workspace.templates.iter().any(|t| t.id == id)
        || workspace.runs.iter().any(|r| {
            r.id == id
                || r.steps.iter().any(|s| {
                    s.attempts
                        .iter()
                        .any(|a| a.id == id || a.annotations.iter().any(|n| n.id == id))
                })
        })
    {
        Err("此 ID 已存在，请使用新的 ID".into())
    } else {
        Ok(())
    }
}

fn new_attempt<'a>(
    step: &'a mut RunStep,
    id: String,
    document_revision: u32,
    parameters: &BTreeMap<String, String>,
) -> Result<&'a mut Attempt, String> {
    if step
        .attempts
        .iter()
        .any(|attempt| attempt.outcome == Outcome::Draft)
    {
        return Err("此步骤已有正在填写的记录".into());
    }
    let attempt_no = increment(
        step.attempts
            .iter()
            .map(|attempt| attempt.attempt_no)
            .max()
            .unwrap_or(0),
    )?;
    step.attempts.push(Attempt {
        id,
        attempt_no,
        content_version: step.content_version,
        document_revision,
        step_snapshot: step.definition.clone(),
        parameters: parameters.clone(),
        outcome: Outcome::Draft,
        output_text: String::new(),
        note: String::new(),
        created_at: now(),
        finished_at: None,
        annotations: vec![],
    });
    Ok(step.attempts.last_mut().expect("just inserted"))
}

fn dispatch(
    workspace: &mut Workspace,
    request: &Request,
    origins: &mut HashMap<String, String>,
) -> Result<(), String> {
    let expected = request.expected_revision;
    match &request.action {
        Action::CreateTemplate {
            id,
            name: title,
            markdown,
        } => {
            id_unused(workspace, id)?;
            name(title)?;
            let document = parse_document(markdown);
            let valid = document.diagnostics.is_empty();
            let applied = if valid {
                markdown.clone()
            } else {
                String::new()
            };
            let time = now();
            workspace.templates.push(Template {
                id: id.clone(),
                name: title.trim().into(),
                description: String::new(),
                draft_markdown: markdown.clone(),
                applied_markdown: applied.clone(),
                revision: 1,
                applied_revision: if valid { 1 } else { 0 },
                source_hash: source_hash(&applied),
                created_at: time.clone(),
                updated_at: time,
                archived: false,
            });
        }
        Action::SaveTemplate {
            id,
            name: title,
            description,
            markdown,
        } => {
            name(title)?;
            let template = template_mut(workspace, id, expected)?;
            template.name = title.trim().into();
            template.description = description.clone();
            template.draft_markdown = markdown.clone();
            if parse_document(markdown).diagnostics.is_empty() {
                template.applied_markdown = markdown.clone();
                template.applied_revision = template.revision;
                template.source_hash = source_hash(markdown);
            }
        }
        Action::ArchiveTemplate { id, archived } => {
            template_mut(workspace, id, expected)?.archived = *archived;
        }
        Action::CreateRun {
            id,
            template_id,
            from_run_id,
            name: title,
            context,
            parameters,
        } => {
            id_unused(workspace, id)?;
            name(title)?;
            validate_parameter_values(parameters)?;
            let (source, snapshot, markdown, mut values) = match (template_id, from_run_id) {
                (Some(template_id), None) => {
                    let template = workspace
                        .templates
                        .iter()
                        .find(|template| &template.id == template_id)
                        .ok_or("来源模板不存在")?;
                    if template.archived {
                        return Err("请先恢复已归档模板".into());
                    }
                    if template.draft_markdown != template.applied_markdown {
                        return Err("模板草稿含错误，请修复后创建实例".into());
                    }
                    (
                        Some(template.id.clone()),
                        TemplateSnapshot {
                            template_id: Some(template.id.clone()),
                            name: template.name.clone(),
                            revision: template.revision,
                            markdown: template.applied_markdown.clone(),
                            parameters: BTreeMap::new(),
                        },
                        template.applied_markdown.clone(),
                        BTreeMap::new(),
                    )
                }
                (None, Some(run_id)) => {
                    let source = workspace
                        .runs
                        .iter()
                        .find(|run| &run.id == run_id)
                        .ok_or("来源实例不存在")?;
                    (
                        source.source_template_id.clone(),
                        TemplateSnapshot {
                            template_id: source.source_template_id.clone(),
                            name: source.name.clone(),
                            revision: source.revision,
                            markdown: source.applied_markdown.clone(),
                            parameters: source.parameters.clone(),
                        },
                        source.applied_markdown.clone(),
                        source.parameters.clone(),
                    )
                }
                (None, None) => (
                    None,
                    TemplateSnapshot {
                        template_id: None,
                        name: title.trim().into(),
                        revision: 0,
                        markdown: String::new(),
                        parameters: BTreeMap::new(),
                    },
                    String::new(),
                    BTreeMap::new(),
                ),
                _ => return Err("只能选择一个实例来源".into()),
            };
            values.extend(parameters.clone());
            let time = now();
            let mut run = Run {
                id: id.clone(),
                name: title.trim().into(),
                context: context.clone(),
                source_template_id: source,
                initial_template_snapshot: snapshot,
                draft_markdown: String::new(),
                applied_markdown: String::new(),
                parameters: BTreeMap::new(),
                draft_parameters: values,
                revision: 1,
                applied_revision: 1,
                created_at: time.clone(),
                updated_at: time,
                closed_at: None,
                summary_note: String::new(),
                selected_step_id: None,
                steps: vec![],
                summary: Summary::default(),
            };
            apply_document(&mut run, &markdown)?;
            run.initial_template_snapshot.parameters = run.parameters.clone();
            run.selected_step_id = run
                .steps
                .iter()
                .find(|step| step.present)
                .map(|step| step.step_id.clone());
            refresh_run(&mut run);
            workspace.runs.push(run);
        }
        Action::SaveRunDraft {
            id,
            markdown,
            parameters,
        } => {
            if let Some(values) = parameters {
                validate_parameter_values(values)?;
            }
            let run = run_mut(workspace, id, expected)?;
            run.draft_markdown = markdown.clone();
            if let Some(values) = parameters {
                run.draft_parameters = values.clone();
            }
        }
        Action::ApplyRunDraft { id } => {
            let run = run_mut(workspace, id, expected)?;
            apply_document(run, &run.draft_markdown.clone())?;
            run.applied_revision = run.revision;
        }
        Action::DiscardRunDraft { id } => {
            let run = run_mut(workspace, id, expected)?;
            run.draft_markdown = run.applied_markdown.clone();
            run.draft_parameters = run.parameters.clone();
        }
        Action::SetSelectedStep { id, step_id } => {
            let run = run_mut(workspace, id, expected)?;
            if let Some(step_id) = step_id {
                step_mut(run, step_id)?;
            }
            run.selected_step_id = step_id.clone();
        }
        Action::UpdateRun {
            id,
            name: title,
            context,
        } => {
            name(title)?;
            let run = run_mut(workspace, id, expected)?;
            run.name = title.trim().into();
            run.context = context.clone();
        }
        Action::BeginAttempt {
            run_id,
            step_id,
            id,
        } => {
            id_unused(workspace, id)?;
            let run = run_mut(workspace, run_id, expected)?;
            let document_revision = run.applied_revision;
            let parameters = run.parameters.clone();
            new_attempt(
                step_mut(run, step_id)?,
                id.clone(),
                document_revision,
                &parameters,
            )?;
        }
        Action::SaveAttempt {
            run_id,
            step_id,
            attempt_id,
            output_text,
            note,
        } => {
            let run = run_mut(workspace, run_id, expected)?;
            let attempt = step_mut(run, step_id)?
                .attempts
                .iter_mut()
                .find(|attempt| &attempt.id == attempt_id)
                .ok_or("本轮记录不存在")?;
            if attempt.outcome != Outcome::Draft {
                return Err("已结束的记录只能追加说明或更正结果".into());
            }
            attempt.output_text = output_text.clone();
            attempt.note = note.clone();
        }
        Action::FinishAttempt {
            run_id,
            step_id,
            attempt_id,
            outcome,
            output_text,
            note,
        } => {
            if *outcome == Outcome::Draft {
                return Err("结束结果不能是草稿".into());
            }
            if matches!(outcome, Outcome::Failed | Outcome::Skipped) && note.trim().is_empty() {
                return Err("失败或跳过必须填写说明".into());
            }
            let exists = workspace
                .runs
                .iter()
                .find(|run| &run.id == run_id)
                .and_then(|run| run.steps.iter().find(|step| &step.step_id == step_id))
                .is_some_and(|step| {
                    step.attempts
                        .iter()
                        .any(|attempt| &attempt.id == attempt_id)
                });
            if !exists {
                id_unused(workspace, attempt_id)?;
            }
            let run = run_mut(workspace, run_id, expected)?;
            let document_revision = run.applied_revision;
            let parameters = run.parameters.clone();
            let step = step_mut(run, step_id)?;
            if !exists {
                new_attempt(step, attempt_id.clone(), document_revision, &parameters)?;
            }
            let attempt = step
                .attempts
                .iter_mut()
                .find(|attempt| &attempt.id == attempt_id)
                .ok_or("本轮记录不存在")?;
            if attempt.outcome != Outcome::Draft {
                return Err("已结束的记录只能追加说明或更正结果".into());
            }
            attempt.output_text = output_text.clone();
            attempt.note = note.clone();
            attempt.outcome = *outcome;
            attempt.finished_at = Some(now());
        }
        Action::AnnotateAttempt {
            run_id,
            step_id,
            attempt_id,
            id,
            text,
            corrected_outcome,
        } => {
            id_unused(workspace, id)?;
            if text.trim().is_empty() {
                return Err("追加说明或更正原因不能为空".into());
            }
            if matches!(corrected_outcome, Some(Outcome::Draft | Outcome::Withdrawn)) {
                return Err("更正结果仅支持完成、失败或跳过".into());
            }
            let run = run_mut(workspace, run_id, expected)?;
            let step = run
                .steps
                .iter_mut()
                .find(|step| &step.step_id == step_id)
                .ok_or("步骤不存在")?;
            let attempt = step
                .attempts
                .iter_mut()
                .find(|attempt| &attempt.id == attempt_id)
                .ok_or("本轮记录不存在")?;
            if attempt.outcome == Outcome::Draft {
                return Err("请先结束本轮记录".into());
            }
            if attempt.outcome == Outcome::Withdrawn {
                return Err("作废记录只读，请新建轮次".into());
            }
            let previous_outcome = corrected_outcome.map(|_| effective_outcome(attempt));
            attempt.annotations.push(Annotation {
                id: id.clone(),
                text: text.clone(),
                previous_outcome,
                corrected_outcome: *corrected_outcome,
                created_at: now(),
            });
        }
        Action::CloseRun { id, summary_note } => {
            let run = run_mut(workspace, id, expected)?;
            if run.draft_markdown != run.applied_markdown || run.draft_parameters != run.parameters
            {
                return Err("请先应用或放弃流程及参数草稿，再留档".into());
            }
            if run.steps.iter().any(|step| {
                step.attempts
                    .iter()
                    .any(|attempt| attempt.outcome == Outcome::Draft)
            }) {
                return Err("请先结束或作废正在填写的记录，再留档".into());
            }
            run.summary_note = summary_note.clone();
            run.closed_at = Some(now());
        }
        Action::ImportBundle { json: input } => {
            import(workspace, input, origins)?;
        }
    }
    for run in &mut workspace.runs {
        refresh_run(run);
    }
    Ok(())
}

/// Parse and validate a backup without opening or writing any database.
/// Both the import preview and the committing operation use this exact boundary.
/// External template references remain here for provenance; import remaps them.
pub fn validate_backup(input: &str) -> Result<Workspace, String> {
    validate_backup_data(input).map(|(workspace, _)| workspace)
}

fn validate_backup_data(input: &str) -> Result<(Workspace, u32), String> {
    if input.len() > MAX_IMPORT_BYTES {
        return Err("备份文件超过 32 MiB 上限".into());
    }
    let backup: Backup = decode(input)?;
    if backup.format != "runbook-backup" || !matches!(backup.schema_version, 1 | 2) {
        return Err("不支持此备份格式或版本".into());
    }
    validate_time(&backup.exported_at)?;
    let imported = Workspace {
        templates: backup.templates,
        runs: backup.runs,
    };
    // A backup may export an instance without its source template. Source links
    // outside the package are provenance, never links to coincident local IDs.
    let template_ids: HashSet<_> = imported
        .templates
        .iter()
        .map(|template| template.id.as_str())
        .collect();
    let mut validation = imported.clone();
    for run in &mut validation.runs {
        if run
            .source_template_id
            .as_deref()
            .is_some_and(|id| !template_ids.contains(id))
        {
            run.source_template_id = None;
        }
    }
    validate_workspace(&validation)?;
    validate_import_metadata(&imported)?;
    Ok((imported, backup.schema_version))
}

fn import(
    workspace: &mut Workspace,
    input: &str,
    origins: &mut HashMap<String, String>,
) -> Result<(), String> {
    let (mut imported, schema_version) = validate_backup_data(input)?;
    let time = now();
    let mut mapping = HashMap::new();
    for template in &imported.templates {
        mapping.insert(template.id.clone(), Uuid::new_v4().to_string());
    }
    let provenance = |original_id: &str| -> String {
        serde_json::json!({ "schema_version": schema_version, "original_id": original_id, "imported_at": time })
            .to_string()
    };
    for template in &mut imported.templates {
        let id = mapping.get(&template.id).expect("mapped template").clone();
        origins.insert(id.clone(), provenance(&template.id));
        template.id = id;
    }
    for run in &mut imported.runs {
        let id = Uuid::new_v4().to_string();
        origins.insert(id.clone(), provenance(&run.id));
        run.id = id;
        run.source_template_id = run
            .source_template_id
            .as_ref()
            .and_then(|id| mapping.get(id).cloned());
        if let Some(id) = &run.initial_template_snapshot.template_id {
            if let Some(mapped) = mapping.get(id) {
                run.initial_template_snapshot.template_id = Some(mapped.clone());
            }
        }
        for step in &mut run.steps {
            for attempt in &mut step.attempts {
                let id = Uuid::new_v4().to_string();
                origins.insert(id.clone(), provenance(&attempt.id));
                attempt.id = id;
                for annotation in &mut attempt.annotations {
                    let id = Uuid::new_v4().to_string();
                    origins.insert(id.clone(), provenance(&annotation.id));
                    annotation.id = id;
                }
            }
        }
        refresh_run(run);
    }
    workspace.templates.extend(imported.templates);
    workspace.runs.extend(imported.runs);
    Ok(())
}

fn validate_time(time: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(time)
        .map(|_| ())
        .map_err(|_| "备份包含无效的 ISO 8601 时间".into())
}

fn chronological(first: &str, second: &str) -> Result<(), String> {
    let first = chrono::DateTime::parse_from_rfc3339(first).map_err(|_| "备份包含无效时间")?;
    let second = chrono::DateTime::parse_from_rfc3339(second).map_err(|_| "备份包含无效时间")?;
    if second < first {
        Err("备份记录的时间先后顺序无效".into())
    } else {
        Ok(())
    }
}

fn validate_import_metadata(workspace: &Workspace) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut check_id = |id: &str| -> Result<(), String> {
        uuid(id)?;
        if !ids.insert(id.to_owned()) {
            return Err("备份实体 ID 重复".into());
        }
        Ok(())
    };
    for template in &workspace.templates {
        check_id(&template.id)?;
        name(&template.name)?;
        validate_time(&template.created_at)?;
        validate_time(&template.updated_at)?;
        chronological(&template.created_at, &template.updated_at)?;
    }
    for run in &workspace.runs {
        check_id(&run.id)?;
        name(&run.name)?;
        validate_time(&run.created_at)?;
        validate_time(&run.updated_at)?;
        chronological(&run.created_at, &run.updated_at)?;
        if let Some(time) = &run.closed_at {
            validate_time(time)?;
            chronological(&run.created_at, time)?;
        }
        if let Some(id) = &run.source_template_id {
            uuid(id)?;
        }
        if let Some(id) = &run.initial_template_snapshot.template_id {
            uuid(id)?;
        }
        for step in &run.steps {
            uuid(&step.step_id)?;
            for attempt in &step.attempts {
                check_id(&attempt.id)?;
                validate_time(&attempt.created_at)?;
                chronological(&run.created_at, &attempt.created_at)?;
                if let Some(time) = &attempt.finished_at {
                    validate_time(time)?;
                    chronological(&attempt.created_at, time)?;
                }
                let mut previous_time = attempt.finished_at.as_ref().unwrap_or(&attempt.created_at);
                for annotation in &attempt.annotations {
                    check_id(&annotation.id)?;
                    validate_time(&annotation.created_at)?;
                    chronological(previous_time, &annotation.created_at)?;
                    previous_time = &annotation.created_at;
                }
            }
        }
    }
    Ok(())
}
