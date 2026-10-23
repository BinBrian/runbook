use runbook_core::{Backup, Outcome, StepStatus, Workspace};
use runbook_store::{validate_backup, Action, Request, Store};
use uuid::Uuid;

const STEP: &str = "11111111-1111-4111-8111-111111111111";
const COMMAND: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn id() -> String {
    Uuid::new_v4().to_string()
}
fn markdown(text: &str) -> String {
    format!("# Maintenance\n\n<!-- runbook:document version=\"1\" -->\n\n<!-- runbook:step id=\"{STEP}\" -->\n\n## Check\n\n<!-- runbook:command id=\"{COMMAND}\" -->\n\n```powershell\n{text}\n```\n\n<!-- /runbook:step -->\n")
}
fn request(action: Action, revision: Option<u32>) -> Request {
    Request {
        operation_id: id(),
        expected_revision: revision,
        action,
    }
}
fn act(store: &mut Store, action: Action, revision: Option<u32>) -> Workspace {
    store.perform(request(action, revision)).unwrap()
}
fn setup(store: &mut Store) -> (String, String) {
    let template_id = id();
    let run_id = id();
    act(
        store,
        Action::CreateTemplate {
            id: template_id.clone(),
            name: "Patch".into(),
            markdown: markdown("Write-Output 'sample'"),
        },
        None,
    );
    act(
        store,
        Action::CreateRun {
            parameters: Default::default(),
            id: run_id.clone(),
            template_id: Some(template_id.clone()),
            from_run_id: None,
            name: "Maintenance".into(),
            context: "Local example".into(),
        },
        None,
    );
    (template_id, run_id)
}

#[test]
fn templates_and_execution_snapshots_are_independent() {
    let mut store = Store::memory().unwrap();
    let (template, run) = setup(&mut store);
    let workspace = act(
        &mut store,
        Action::SaveTemplate {
            id: template.clone(),
            name: "Changed".into(),
            description: "New template".into(),
            markdown: markdown("Write-Output 'changed'"),
        },
        Some(1),
    );
    assert!(workspace.templates[0].applied_markdown.contains("changed"));
    assert!(workspace.runs[0].applied_markdown.contains("sample"));
    assert_eq!(workspace.runs[0].initial_template_snapshot.name, "Patch");
    act(
        &mut store,
        Action::SaveRunDraft {
            parameters: None,
            id: run.clone(),
            markdown: markdown("Write-Output 'instance'"),
        },
        Some(1),
    );
    let workspace = act(&mut store, Action::ApplyRunDraft { id: run }, Some(2));
    assert!(workspace.runs[0].applied_markdown.contains("instance"));
    assert!(workspace.templates[0].applied_markdown.contains("changed"));
    assert_eq!(workspace.runs[0].steps[0].content_version, 2);
}

#[test]
fn invalid_drafts_persist_without_replacing_applied_content() {
    let mut store = Store::memory().unwrap();
    let (template, run) = setup(&mut store);
    let invalid = "<!-- runbook:step id=\"broken\" -->".to_string();
    let workspace = act(
        &mut store,
        Action::SaveTemplate {
            id: template,
            name: "Patch".into(),
            description: String::new(),
            markdown: invalid.clone(),
        },
        Some(1),
    );
    assert_eq!(workspace.templates[0].draft_markdown, invalid);
    assert!(workspace.templates[0].applied_markdown.contains("sample"));
    act(
        &mut store,
        Action::SaveRunDraft {
            parameters: None,
            id: run.clone(),
            markdown: invalid.clone(),
        },
        Some(1),
    );
    assert!(store
        .perform(request(Action::ApplyRunDraft { id: run.clone() }, Some(2)))
        .is_err());
    let workspace = store.workspace().unwrap();
    assert_eq!(workspace.runs[0].draft_markdown, invalid);
    assert_eq!(workspace.runs[0].revision, 2);
    assert!(workspace.runs[0].applied_markdown.contains("sample"));
    assert!(store
        .perform(request(
            Action::CloseRun {
                id: run,
                summary_note: String::new()
            },
            Some(2)
        ))
        .is_err());
}

#[test]
fn revision_is_shared_by_draft_selection_and_all_results() {
    let mut store = Store::memory().unwrap();
    let (_, run) = setup(&mut store);
    let attempt = id();
    act(
        &mut store,
        Action::BeginAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            id: attempt.clone(),
        },
        Some(1),
    );
    assert!(store
        .perform(request(
            Action::SaveRunDraft {
                parameters: None,
                id: run.clone(),
                markdown: "stale".into()
            },
            Some(1)
        ))
        .is_err());
    let workspace = act(
        &mut store,
        Action::SaveAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: attempt.clone(),
            output_text: "last pasted output".into(),
            note: "working".into(),
        },
        Some(2),
    );
    assert_eq!(workspace.runs[0].revision, 3);
    assert_eq!(workspace.runs[0].steps[0].status, StepStatus::Active);
    assert!(store
        .perform(request(
            Action::CloseRun {
                id: run.clone(),
                summary_note: String::new()
            },
            Some(3)
        ))
        .is_err());
    let workspace = act(
        &mut store,
        Action::FinishAttempt {
            run_id: run,
            step_id: STEP.into(),
            attempt_id: attempt,
            outcome: Outcome::Completed,
            output_text: "final unsaved output".into(),
            note: String::new(),
        },
        Some(3),
    );
    assert_eq!(
        workspace.runs[0].steps[0].attempts[0].output_text,
        "final unsaved output"
    );
    assert_eq!(workspace.runs[0].summary.conclusion, "completed");
}

#[test]
fn ended_attempts_are_immutable_corrections_append_and_retry_is_a_new_round() {
    let mut store = Store::memory().unwrap();
    let (_, run) = setup(&mut store);
    let attempt = id();
    let finish = Action::FinishAttempt {
        run_id: run.clone(),
        step_id: STEP.into(),
        attempt_id: attempt.clone(),
        outcome: Outcome::Failed,
        output_text: "failure".into(),
        note: "checksum mismatch".into(),
    };
    act(&mut store, finish, Some(1));
    assert!(store
        .perform(request(
            Action::SaveAttempt {
                run_id: run.clone(),
                step_id: STEP.into(),
                attempt_id: attempt.clone(),
                output_text: "overwrite".into(),
                note: String::new()
            },
            Some(2)
        ))
        .is_err());
    let workspace = act(
        &mut store,
        Action::AnnotateAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: attempt.clone(),
            id: id(),
            text: "The file was correct; recorded the wrong result".into(),
            corrected_outcome: Some(Outcome::Completed),
        },
        Some(2),
    );
    let recorded = &workspace.runs[0].steps[0].attempts[0];
    assert_eq!(recorded.outcome, Outcome::Failed);
    assert_eq!(recorded.annotations.len(), 1);
    assert_eq!(workspace.runs[0].steps[0].status, StepStatus::Completed);
    let workspace = act(
        &mut store,
        Action::BeginAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            id: id(),
        },
        Some(3),
    );
    let attempts = &workspace.runs[0].steps[0].attempts;
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[1].attempt_no, 2);
    assert!(attempts[1].output_text.is_empty());
    assert_eq!(workspace.runs[0].steps[0].status, StepStatus::Active);
}

#[test]
fn failure_and_skip_require_a_reason_and_closed_instances_reject_writes() {
    let mut store = Store::memory().unwrap();
    let (_, run) = setup(&mut store);
    for outcome in [Outcome::Failed, Outcome::Skipped] {
        assert!(store
            .perform(request(
                Action::FinishAttempt {
                    run_id: run.clone(),
                    step_id: STEP.into(),
                    attempt_id: id(),
                    outcome,
                    output_text: String::new(),
                    note: "  ".into()
                },
                Some(1)
            ))
            .is_err());
    }
    act(
        &mut store,
        Action::FinishAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: id(),
            outcome: Outcome::Skipped,
            output_text: String::new(),
            note: "Not needed for this patch".into(),
        },
        Some(1),
    );
    let workspace = act(
        &mut store,
        Action::CloseRun {
            id: run.clone(),
            summary_note: "Retained".into(),
        },
        Some(2),
    );
    assert_eq!(workspace.runs[0].summary.conclusion, "completed_with_skips");
    assert!(workspace.runs[0].closed_at.is_some());
    assert!(store
        .perform(request(
            Action::SaveRunDraft {
                parameters: None,
                id: run.clone(),
                markdown: "replace".into()
            },
            Some(3)
        ))
        .is_err());
    assert!(store
        .perform(request(
            Action::BeginAttempt {
                run_id: run,
                step_id: STEP.into(),
                id: id()
            },
            Some(3)
        ))
        .is_err());
}

#[test]
fn receipts_survive_reopen_and_precede_revision_validation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runbook.sqlite");
    let mut store = Store::open(&path).unwrap();
    let (_, run) = setup(&mut store);
    let mut req = request(
        Action::BeginAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            id: id(),
        },
        Some(1),
    );
    let first = store.perform(req.clone()).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    req.expected_revision = Some(999);
    assert_eq!(store.perform(req.clone()).unwrap(), first);
    let workspace = store.workspace().unwrap();
    assert_eq!(workspace.runs[0].steps[0].attempts.len(), 1);
    let current = act(
        &mut store,
        Action::SaveRunDraft {
            parameters: None,
            id: run.clone(),
            markdown: "# A newer draft".into(),
        },
        Some(2),
    );
    assert_eq!(store.perform(req.clone()).unwrap(), current);
    req.action = Action::BeginAttempt {
        run_id: run,
        step_id: STEP.into(),
        id: id(),
    };
    assert!(store.perform(req).unwrap_err().contains("不同请求"));
    assert_eq!(store.workspace().unwrap().runs[0].revision, 3);
}

#[test]
fn active_draft_and_flow_draft_restore_after_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runbook.sqlite");
    let mut store = Store::open(&path).unwrap();
    let (_, run) = setup(&mut store);
    let attempt = id();
    act(
        &mut store,
        Action::BeginAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            id: attempt.clone(),
        },
        Some(1),
    );
    act(
        &mut store,
        Action::SaveAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: attempt,
            output_text: "partial output".into(),
            note: "Resume tomorrow".into(),
        },
        Some(2),
    );
    let before = act(
        &mut store,
        Action::SaveRunDraft {
            parameters: None,
            id: run,
            markdown: markdown("Write-Output 'changed'"),
        },
        Some(3),
    );
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.workspace().unwrap(), before);
}

#[test]
fn applying_flow_blocks_active_record_and_preserves_removed_history() {
    let mut store = Store::memory().unwrap();
    let (_, run) = setup(&mut store);
    let attempt = id();
    act(
        &mut store,
        Action::BeginAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            id: attempt.clone(),
        },
        Some(1),
    );
    act(
        &mut store,
        Action::SaveRunDraft {
            parameters: None,
            id: run.clone(),
            markdown: "# Empty flow\n".into(),
        },
        Some(2),
    );
    assert!(store
        .perform(request(Action::ApplyRunDraft { id: run.clone() }, Some(3)))
        .is_err());
    act(
        &mut store,
        Action::FinishAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: attempt,
            outcome: Outcome::Withdrawn,
            output_text: "preserved".into(),
            note: "flow changed".into(),
        },
        Some(3),
    );
    let workspace = act(&mut store, Action::ApplyRunDraft { id: run }, Some(4));
    assert_eq!(workspace.runs[0].steps.len(), 1);
    assert!(!workspace.runs[0].steps[0].present);
    assert_eq!(
        workspace.runs[0].steps[0].attempts[0].output_text,
        "preserved"
    );
    assert_eq!(workspace.runs[0].summary.removed, 1);
    assert_eq!(workspace.runs[0].summary.conclusion, "no_steps");
}

#[test]
fn backup_import_remaps_ids_keeps_all_history_and_does_not_overwrite() {
    let mut store = Store::memory().unwrap();
    let (_, run) = setup(&mut store);
    let attempt = id();
    act(
        &mut store,
        Action::FinishAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: attempt.clone(),
            outcome: Outcome::Failed,
            output_text: "test log".into(),
            note: "failure".into(),
        },
        Some(1),
    );
    act(
        &mut store,
        Action::AnnotateAttempt {
            run_id: run.clone(),
            step_id: STEP.into(),
            attempt_id: attempt,
            id: id(),
            text: "resolved".into(),
            corrected_outcome: Some(Outcome::Completed),
        },
        Some(2),
    );
    act(
        &mut store,
        Action::CloseRun {
            id: run,
            summary_note: "complete".into(),
        },
        Some(3),
    );
    let before = store.workspace().unwrap();
    let backup = store.export().unwrap();
    let workspace = act(
        &mut store,
        Action::ImportBundle {
            json: backup.clone(),
        },
        None,
    );
    assert_eq!(workspace.templates.len(), 2);
    assert_eq!(workspace.runs.len(), 2);
    let imported = &workspace.runs[1];
    let original = &before.runs[0];
    assert_ne!(imported.id, original.id);
    assert_ne!(imported.source_template_id, original.source_template_id);
    assert_eq!(
        imported.source_template_id.as_ref(),
        Some(&workspace.templates[1].id)
    );
    assert_eq!(imported.closed_at, original.closed_at);
    assert_eq!(imported.applied_markdown, original.applied_markdown);
    assert_eq!(imported.steps[0].step_id, original.steps[0].step_id);
    assert_ne!(
        imported.steps[0].attempts[0].id,
        original.steps[0].attempts[0].id
    );
    assert_eq!(imported.steps[0].attempts[0].annotations.len(), 1);
    assert_eq!(imported.summary, original.summary);
    assert_eq!(workspace.runs[0], *original);
    let workspace = act(&mut store, Action::ImportBundle { json: backup }, None);
    assert_eq!(workspace.runs.len(), 3);
}

#[test]
fn malformed_import_rejects_the_whole_package_and_standalone_run_cannot_hijack_template() {
    let mut store = Store::memory().unwrap();
    setup(&mut store);
    let mut backup: Backup = serde_json::from_str(&store.export().unwrap()).unwrap();
    backup.templates[0].name = "should not leak".into();
    backup.runs[0].steps[0].definition.content_hash = "forged".into();
    assert!(store
        .perform(request(
            Action::ImportBundle {
                json: serde_json::to_string(&backup).unwrap()
            },
            None
        ))
        .is_err());
    assert_eq!(store.workspace().unwrap().templates.len(), 1);
    let mut backup: Backup = serde_json::from_str(&store.export().unwrap()).unwrap();
    backup.templates.clear();
    let workspace = act(
        &mut store,
        Action::ImportBundle {
            json: serde_json::to_string(&backup).unwrap(),
        },
        None,
    );
    assert!(workspace.runs[1].source_template_id.is_none());
    assert!(workspace.runs[1]
        .initial_template_snapshot
        .template_id
        .is_some());
}

#[test]
fn newer_database_version_is_rejected_without_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("future.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert!(Store::open(&path).is_err());
    let connection = rusqlite::Connection::open(&path).unwrap();
    let version: i32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 99);
    let count: i32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn backup_preview_and_commit_share_validation_and_allow_standalone_instances() {
    let mut store = Store::memory().unwrap();
    setup(&mut store);
    let before = store.workspace().unwrap();
    let mut backup: Backup = serde_json::from_str(&store.export().unwrap()).unwrap();
    backup.templates.clear();
    let standalone = serde_json::to_string(&backup).unwrap();
    let preview = validate_backup(&standalone).unwrap();
    assert_eq!(preview.templates.len(), 0);
    assert_eq!(preview.runs.len(), 1);
    assert_eq!(store.workspace().unwrap(), before);
    let imported = act(&mut store, Action::ImportBundle { json: standalone }, None);
    assert!(imported.runs[1].source_template_id.is_none());

    let mut invalid_packages = Vec::new();
    let mut future = backup.clone();
    future.schema_version = 999;
    invalid_packages.push(serde_json::to_string(&future).unwrap());
    let mut invalid_time = backup.clone();
    invalid_time.runs[0].created_at = "not a date".into();
    invalid_packages.push(serde_json::to_string(&invalid_time).unwrap());
    let mut invalid_reference = backup.clone();
    invalid_reference.runs[0].source_template_id = Some("bad-id".into());
    invalid_packages.push(serde_json::to_string(&invalid_reference).unwrap());
    let mut invalid_projection = backup;
    invalid_projection.runs[0].steps[0].definition.content_hash = "forged".into();
    invalid_packages.push(serde_json::to_string(&invalid_projection).unwrap());
    let unchanged = store.workspace().unwrap();
    for input in invalid_packages {
        let preview_error = validate_backup(&input).unwrap_err();
        let commit_error = store
            .perform(request(Action::ImportBundle { json: input }, None))
            .unwrap_err();
        assert_eq!(preview_error, commit_error);
        assert_eq!(store.workspace().unwrap(), unchanged);
    }
}
