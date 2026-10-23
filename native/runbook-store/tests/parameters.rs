use runbook_core::{Backup, Outcome, StepStatus, Workspace};
use runbook_store::{validate_backup, Action, Request, Store};
use std::{collections::BTreeMap, path::Path};
use uuid::Uuid;

const STEP: &str = "11111111-1111-4111-8111-111111111111";
const COMMAND: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn values(host: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("HOST".into(), host.into())])
}
fn source(default: &str) -> String {
    let definitions = serde_json::to_string(&values(default))
        .unwrap()
        .replace('>', "\\u003e");
    format!("<!-- runbook:document version=\"1\" -->\n\n<!-- runbook:parameters {definitions} -->\n\n<!-- runbook:step id=\"{STEP}\" -->\n\n## Check host\n\n<!-- runbook:command id=\"{COMMAND}\" -->\n\n```powershell\nWrite-Output '{{{{rb:HOST}}}}'\n```\n\n<!-- /runbook:step -->\n")
}
fn plain_source() -> String {
    source("old-default")
        .lines()
        .filter(|line| !line.starts_with("<!-- runbook:parameters "))
        .collect::<Vec<_>>()
        .join("\n")
        .replace("{{rb:HOST}}", "original-host")
}
fn request(action: Action, expected_revision: Option<u32>) -> Request {
    Request {
        operation_id: id(),
        expected_revision,
        action,
    }
}
fn run_action(store: &mut Store, run_id: &str, action: Action) -> Result<Workspace, String> {
    let revision = store
        .workspace()?
        .runs
        .iter()
        .find(|run| run.id == run_id)
        .unwrap()
        .revision;
    store.perform(request(action, Some(revision)))
}
fn create(
    store: &mut Store,
    markdown: String,
    parameters: BTreeMap<String, String>,
) -> (String, String) {
    let template = id();
    let run = id();
    store
        .perform(request(
            Action::CreateTemplate {
                id: template.clone(),
                name: "Maintenance".into(),
                markdown,
            },
            None,
        ))
        .unwrap();
    store
        .perform(request(
            Action::CreateRun {
                id: run.clone(),
                template_id: Some(template.clone()),
                from_run_id: None,
                name: "Independent run".into(),
                context: String::new(),
                parameters,
            },
            None,
        ))
        .unwrap();
    (template, run)
}
fn draft(store: &mut Store, run: &str, markdown: String, parameters: BTreeMap<String, String>) {
    run_action(
        store,
        run,
        Action::SaveRunDraft {
            id: run.into(),
            markdown,
            parameters: Some(parameters),
        },
    )
    .unwrap();
}
fn finish(store: &mut Store, run: &str, attempt_id: String) {
    run_action(
        store,
        run,
        Action::FinishAttempt {
            run_id: run.into(),
            step_id: STEP.into(),
            attempt_id,
            outcome: Outcome::Completed,
            output_text: "captured output".into(),
            note: String::new(),
        },
    )
    .unwrap();
}

#[test]
fn defaults_overrides_and_repeated_runs_are_isolated_from_template_updates() {
    let mut store = Store::memory().unwrap();
    let (template, run_id) = create(
        &mut store,
        source("default-host"),
        values("  自己的服务器  "),
    );
    let run = store.workspace().unwrap().runs.remove(0);
    assert_eq!(run.parameters, values("  自己的服务器  "));
    assert_eq!(run.initial_template_snapshot.parameters, run.parameters);
    assert!(run.applied_markdown.contains("{{rb:HOST}}"));
    assert_eq!(
        run.steps[0].definition.commands[0].text,
        "Write-Output '  自己的服务器  '"
    );
    store
        .perform(request(
            Action::SaveTemplate {
                id: template,
                name: "Updated template".into(),
                description: String::new(),
                markdown: source("new-default"),
            },
            Some(1),
        ))
        .unwrap();
    let repeat_id = id();
    let workspace = store
        .perform(request(
            Action::CreateRun {
                id: repeat_id.clone(),
                template_id: None,
                from_run_id: Some(run_id.clone()),
                name: "Repeat own workflow".into(),
                context: String::new(),
                parameters: BTreeMap::new(),
            },
            None,
        ))
        .unwrap();
    let original = workspace.runs.iter().find(|run| run.id == run_id).unwrap();
    let repeat = workspace
        .runs
        .iter()
        .find(|run| run.id == repeat_id)
        .unwrap();
    assert_eq!(*original, run);
    assert_eq!(repeat.applied_markdown, original.applied_markdown);
    assert_eq!(repeat.parameters, original.parameters);
    assert_eq!(
        repeat.initial_template_snapshot.parameters,
        original.parameters
    );
    assert!(repeat.steps[0].attempts.is_empty());
    let mut defaults_store = Store::memory().unwrap();
    create(&mut defaults_store, source("default-only"), BTreeMap::new());
    assert_eq!(
        defaults_store.workspace().unwrap().runs[0].parameters,
        values("default-only")
    );
}

#[test]
fn applying_changed_parameters_keeps_old_attempt_snapshot_and_resets_affected_step() {
    let mut store = Store::memory().unwrap();
    let (_, run_id) = create(&mut store, source("default"), values("first"));
    finish(&mut store, &run_id, id());
    let old_attempt = store.workspace().unwrap().runs[0].steps[0].attempts[0].clone();
    draft(&mut store, &run_id, source("default"), values("second"));
    let before_apply = store.workspace().unwrap();
    assert_eq!(before_apply.runs[0].parameters, values("first"));
    assert_eq!(before_apply.runs[0].steps[0].status, StepStatus::Completed);
    let workspace = run_action(
        &mut store,
        &run_id,
        Action::ApplyRunDraft { id: run_id.clone() },
    )
    .unwrap();
    let run = &workspace.runs[0];
    assert_eq!(run.parameters, values("second"));
    assert_eq!(run.draft_parameters, run.parameters);
    assert_eq!(run.steps[0].content_version, 2);
    assert_eq!(run.steps[0].status, StepStatus::Pending);
    assert_eq!(run.steps[0].attempts[0], old_attempt);
    assert_eq!(old_attempt.parameters, values("first"));
    assert!(old_attempt.step_snapshot.commands[0].text.contains("first"));
    finish(&mut store, &run_id, id());
    let workspace = store.workspace().unwrap();
    assert_eq!(
        workspace.runs[0].steps[0].attempts[1].parameters,
        values("second")
    );
    assert_eq!(workspace.runs[0].steps[0].attempts[0], old_attempt);
}

#[test]
fn active_attempt_blocks_affected_parameter_application_without_losing_draft() {
    let mut store = Store::memory().unwrap();
    let (_, run_id) = create(&mut store, source("default"), values("first"));
    let attempt = id();
    run_action(
        &mut store,
        &run_id,
        Action::BeginAttempt {
            run_id: run_id.clone(),
            step_id: STEP.into(),
            id: attempt.clone(),
        },
    )
    .unwrap();
    draft(&mut store, &run_id, source("default"), values("second"));
    let before = store.workspace().unwrap();
    assert!(run_action(
        &mut store,
        &run_id,
        Action::ApplyRunDraft { id: run_id.clone() }
    )
    .is_err());
    assert_eq!(store.workspace().unwrap(), before);
    finish(&mut store, &run_id, attempt);
    run_action(
        &mut store,
        &run_id,
        Action::ApplyRunDraft { id: run_id.clone() },
    )
    .unwrap();
    assert_eq!(
        store.workspace().unwrap().runs[0].steps[0].content_version,
        2
    );
}

#[test]
fn parameter_drafts_block_close_and_discard_restores_applied_values() {
    let mut store = Store::memory().unwrap();
    let (_, run_id) = create(&mut store, source("default"), values("first"));
    draft(
        &mut store,
        &run_id,
        source("default"),
        values("unsaved-change"),
    );
    assert!(run_action(
        &mut store,
        &run_id,
        Action::CloseRun {
            id: run_id.clone(),
            summary_note: String::new()
        }
    )
    .is_err());
    run_action(
        &mut store,
        &run_id,
        Action::DiscardRunDraft { id: run_id.clone() },
    )
    .unwrap();
    let run = store.workspace().unwrap().runs.remove(0);
    assert_eq!(run.draft_parameters, values("first"));
    run_action(
        &mut store,
        &run_id,
        Action::CloseRun {
            id: run_id.clone(),
            summary_note: String::new(),
        },
    )
    .unwrap();
    assert!(store.workspace().unwrap().runs[0].closed_at.is_some());
}

#[test]
fn applying_removed_definitions_discards_extra_values_without_erasing_saved_draft_early() {
    let mut store = Store::memory().unwrap();
    let (_, run_id) = create(&mut store, source("default"), values("host"));
    draft(&mut store, &run_id, plain_source(), values("host"));
    assert_eq!(
        store.workspace().unwrap().runs[0].draft_parameters,
        values("host")
    );
    let workspace = run_action(
        &mut store,
        &run_id,
        Action::ApplyRunDraft { id: run_id.clone() },
    )
    .unwrap();
    assert!(workspace.runs[0].parameters.is_empty());
    assert!(workspace.runs[0].draft_parameters.is_empty());
}

#[test]
fn parameters_and_invalid_raw_drafts_survive_reopen_and_schema2_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("parameters.sqlite3");
    let mut store = Store::open(&path).unwrap();
    let (_, run_id) = create(&mut store, source("default"), values("applied"));
    finish(&mut store, &run_id, id());
    draft(
        &mut store,
        &run_id,
        "<!-- runbook:step id=\"invalid\" -->".into(),
        values("草稿\nline 2"),
    );
    let before = store.workspace().unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.workspace().unwrap(), before);
    let exported = store.export().unwrap();
    let backup: Backup = serde_json::from_str(&exported).unwrap();
    assert_eq!(backup.schema_version, 2);
    let mut fresh = Store::memory().unwrap();
    let imported = fresh
        .perform(request(Action::ImportBundle { json: exported }, None))
        .unwrap();
    assert_eq!(imported.runs[0].parameters, values("applied"));
    assert_eq!(imported.runs[0].draft_parameters, values("草稿\nline 2"));
    assert_eq!(
        imported.runs[0].steps[0].attempts[0].parameters,
        values("applied")
    );
}

#[test]
fn import_rejects_changed_parameter_values_with_a_forged_current_projection() {
    let mut store = Store::memory().unwrap();
    create(&mut store, source("default"), values("original"));
    let mut backup: Backup = serde_json::from_str(&store.export().unwrap()).unwrap();
    backup.runs[0].parameters = values("forged");
    backup.runs[0].draft_parameters = values("forged");
    let input = serde_json::to_string(&backup).unwrap();
    assert!(validate_backup(&input).is_err());
    let before = store.workspace().unwrap();
    assert!(store
        .perform(request(Action::ImportBundle { json: input }, None))
        .is_err());
    assert_eq!(store.workspace().unwrap(), before);
}

fn strip_new_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.remove("parameters");
            object.remove("draft_parameters");
            for value in object.values_mut() {
                strip_new_fields(value);
            }
        }
        serde_json::Value::Array(array) => {
            for value in array {
                strip_new_fields(value);
            }
        }
        _ => {}
    }
}

#[test]
fn legacy_schema1_backup_without_parameter_fields_remains_importable() {
    let mut store = Store::memory().unwrap();
    let (_, run_id) = create(&mut store, plain_source(), BTreeMap::new());
    finish(&mut store, &run_id, id());
    let mut value: serde_json::Value = serde_json::from_str(&store.export().unwrap()).unwrap();
    value["schema_version"] = 1.into();
    strip_new_fields(&mut value);
    let input = value.to_string();
    let preview = validate_backup(&input).unwrap();
    assert!(preview.runs[0].parameters.is_empty());
    assert!(preview.runs[0].steps[0].attempts[0].parameters.is_empty());
    let mut fresh = Store::memory().unwrap();
    let imported = fresh
        .perform(request(Action::ImportBundle { json: input }, None))
        .unwrap();
    assert_eq!(
        imported.runs[0].steps[0].attempts[0].output_text,
        "captured output"
    );
}

fn downgrade_payloads(path: &Path) -> String {
    let connection = rusqlite::Connection::open(path).unwrap();
    for table in ["runs", "step_attempts"] {
        let mut statement = connection
            .prepare(&format!("SELECT id,payload FROM {table}"))
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for (id, payload) in rows {
            let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
            strip_new_fields(&mut value);
            connection
                .execute(
                    &format!("UPDATE {table} SET payload=?1 WHERE id=?2"),
                    rusqlite::params![value.to_string(), id],
                )
                .unwrap();
        }
    }
    connection.pragma_update(None, "user_version", 1).unwrap();
    connection
        .query_row("SELECT payload FROM runs LIMIT 1", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn schema1_database_migration_makes_consistent_backup_and_preserves_payload_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("old.sqlite3");
    let mut store = Store::open(&path).unwrap();
    let (_, run_id) = create(&mut store, plain_source(), BTreeMap::new());
    finish(&mut store, &run_id, id());
    drop(store);
    let original_payload = downgrade_payloads(&path);
    let store = Store::open(&path).unwrap();
    let workspace = store.workspace().unwrap();
    assert!(workspace.runs[0].parameters.is_empty());
    assert_eq!(
        workspace.runs[0].steps[0].attempts[0].output_text,
        "captured output"
    );
    let backups = std::fs::read_dir(directory.path())
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".schema1-backup-")
                .then_some(path)
        })
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    let version: i32 = backup
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let saved: String = backup
        .query_row("SELECT payload FROM runs LIMIT 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(saved, original_payload);
    let active = rusqlite::Connection::open(&path).unwrap();
    let version: i32 = active
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
    let active_payload: String = active
        .query_row("SELECT payload FROM runs LIMIT 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(active_payload, original_payload);
}

#[test]
fn invalid_legacy_database_does_not_advance_version_or_overwrite_original_data() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("corrupt.sqlite3");
    let mut store = Store::open(&path).unwrap();
    create(&mut store, plain_source(), BTreeMap::new());
    drop(store);
    downgrade_payloads(&path);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let payload: String = connection
        .query_row("SELECT payload FROM run_steps LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let mut forged: serde_json::Value = serde_json::from_str(&payload).unwrap();
    forged["definition"]["content_hash"] = "wrong".into();
    connection
        .execute("UPDATE run_steps SET payload=?1", [forged.to_string()])
        .unwrap();
    drop(connection);
    assert!(Store::open(&path).is_err());
    let connection = rusqlite::Connection::open(&path).unwrap();
    let version: i32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let still_forged: String = connection
        .query_row("SELECT payload FROM run_steps LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(still_forged, forged.to_string());
}

#[test]
fn old_serialized_requests_keep_their_fingerprint_when_new_optional_fields_are_absent() {
    let create_json = serde_json::json!({ "type":"create_run", "id":id(), "template_id":null, "from_run_id":null, "name":"Old request", "context":"" });
    let action: Action = serde_json::from_value(create_json.clone()).unwrap();
    assert_eq!(serde_json::to_value(action).unwrap(), create_json);
    let save_json =
        serde_json::json!({ "type":"save_run_draft", "id":id(), "markdown":"old text" });
    let action: Action = serde_json::from_value(save_json.clone()).unwrap();
    assert_eq!(serde_json::to_value(action).unwrap(), save_json);
}

#[test]
fn empty_default_whole_command_template_accepts_a_nonempty_instance_override() {
    let mut store = Store::memory().unwrap();
    let markdown = source("").replace("Write-Output '{{rb:HOST}}'", "{{rb:HOST}}");
    let template = id();
    let saved = store
        .perform(request(
            Action::CreateTemplate {
                id: template.clone(),
                name: "Empty default".into(),
                markdown: markdown.clone(),
            },
            None,
        ))
        .unwrap();
    assert_eq!(saved.templates[0].applied_markdown, markdown);
    assert!(store
        .perform(request(
            Action::CreateRun {
                id: id(),
                template_id: Some(template.clone()),
                from_run_id: None,
                name: "Empty command".into(),
                context: String::new(),
                parameters: BTreeMap::new()
            },
            None
        ))
        .is_err());
    let valid = store
        .perform(request(
            Action::CreateRun {
                id: id(),
                template_id: Some(template),
                from_run_id: None,
                name: "Filled command".into(),
                context: String::new(),
                parameters: values("Write-Output 'supplied'"),
            },
            None,
        ))
        .unwrap();
    assert_eq!(
        valid.runs[0].steps[0].definition.commands[0].text,
        "Write-Output 'supplied'"
    );
}

#[test]
fn changing_an_unused_parameter_keeps_active_snapshot_and_content_version() {
    let mut store = Store::memory().unwrap();
    let markdown = source("default").replace(
        "{\"HOST\":\"default\"}",
        "{\"HOST\":\"default\",\"UNUSED\":\"one\"}",
    );
    let (_, run_id) = create(&mut store, markdown.clone(), values("first"));
    run_action(
        &mut store,
        &run_id,
        Action::BeginAttempt {
            run_id: run_id.clone(),
            step_id: STEP.into(),
            id: id(),
        },
    )
    .unwrap();
    let old = store.workspace().unwrap().runs[0].steps[0].attempts[0].clone();
    let mut overrides = values("first");
    overrides.insert("UNUSED".into(), "two".into());
    draft(&mut store, &run_id, markdown, overrides);
    let applied = run_action(
        &mut store,
        &run_id,
        Action::ApplyRunDraft { id: run_id.clone() },
    )
    .unwrap();
    assert_eq!(applied.runs[0].steps[0].status, StepStatus::Active);
    assert_eq!(applied.runs[0].steps[0].content_version, 1);
    assert_eq!(applied.runs[0].steps[0].attempts[0], old);
    assert_eq!(old.parameters.get("UNUSED").unwrap(), "one");
    validate_backup(&store.export().unwrap()).unwrap();
}
