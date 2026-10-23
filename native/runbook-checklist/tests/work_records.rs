use runbook_checklist::*;
use rusqlite::Connection;
use serde_json::json;

fn act(store: &mut Store, value: serde_json::Value) -> Workspace {
    store.apply(serde_json::from_value(value).unwrap()).unwrap()
}
fn document() -> serde_json::Value {
    json!({"groups":[{"id":"g","name":"玩家转区","description":"组说明"}],"parameters":[{"id":"env","name":"环境","description":"全局","defaultValue":"release"},{"id":"player","ownerId":"g","name":"玩家ID","description":"局部","defaultValue":"123"}],"steps":[{"id":"one","groupId":"g","title":["核对",{"parameterId":"player"}],"description":["说明"],"commands":[{"id":"cmd","text":["check ",{"parameterId":"env"}]}]},{"id":"two","title":["结束"],"description":[],"commands":[]}]})
}
fn new_work(store: &mut Store, id: &str) {
    act(
        store,
        json!({"type":"create_work","id":id,"name":"维护工作","document":document()}),
    );
}
fn repeat(store: &mut Store, source: &str, id: &str, carry: bool) -> Workspace {
    act(
        store,
        json!({"type":"repeat_work","sourceId":source,"id":id,"name":"再做一次","carryValues":carry}),
    )
}
fn work<'a>(ws: &'a Workspace, id: &str) -> &'a Instance {
    ws.instances.iter().find(|i| i.id == id).unwrap()
}

#[test]
fn direct_new_work_has_no_template_and_requires_explicit_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.work_workspace().unwrap();
    new_work(&mut store, "new");
    let ws = store.workspace().unwrap();
    let item = work(&ws, "new");
    assert!(ws.templates.is_empty());
    assert_eq!(item.status, Status::Draft);
    assert!(item.current_step_id.is_none());
    assert!(item.entries.is_empty());
    assert!(item.source_template_id.is_none());
    assert!(item.source_instance_id.is_none());
    assert_eq!(item.parameter_values["env"], "release");
}
#[test]
fn repeat_copies_applied_values_or_defaults_and_never_results_materials_or_times() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.work_workspace().unwrap();
    new_work(&mut store, "old");
    act(
        &mut store,
        json!({"type":"apply_parameters","id":"old","values":{"env":"preview","player":"456"}}),
    );
    act(&mut store, json!({"type":"start_instance","id":"old"}));
    for (outcome, reason) in [
        ("failed", Some("失败原因")),
        ("skipped", Some("跳过原因")),
        ("completed", None),
    ] {
        act(
            &mut store,
            json!({"type":"record_result","id":"old","outcome":outcome,"reason":reason}),
        );
    }
    act(
        &mut store,
        json!({"type":"add_comment","id":"old","stepId":"one","entryId":"comment","text":"结果备注"}),
    );
    store
        .attach_image(
            "old",
            "one",
            "evidence.png",
            "image/png",
            include_bytes!(
                "../../../docs/examples/patch-maintenance/images/package-check-demo.png"
            ),
        )
        .unwrap();
    act(
        &mut store,
        json!({"type":"archive_instance","id":"old","archived":true}),
    );
    let source = work(&store.workspace().unwrap(), "old").clone();
    let ws = repeat(&mut store, "old", "new", true);
    let copied = work(&ws, "new");
    assert_eq!(work(&ws, "old"), &source);
    assert_eq!(copied.document, source.document);
    assert_eq!(copied.parameter_values, source.parameter_values);
    assert_eq!(copied.source_instance_id.as_deref(), Some("old"));
    assert!(copied.source_template_id.is_none());
    assert_eq!(copied.status, Status::Draft);
    assert!(copied.started_at.is_none());
    assert!(copied.finished_at.is_none());
    assert!(copied.archived_at.is_none());
    assert!(copied.current_step_id.is_none());
    assert!(copied.termination_reason.is_none());
    assert!(copied.entries.is_empty());
    let ws = repeat(&mut store, "old", "defaults", false);
    assert_eq!(work(&ws, "defaults").parameter_values["env"], "release");
    assert_eq!(work(&ws, "defaults").parameter_values["player"], "123");
    let mut changed = copied.document.clone();
    changed.steps.reverse();
    changed.parameters[0].name = "新变量名称".into();
    act(
        &mut store,
        json!({"type":"save_instance","id":"new","name":"独立修改","document":changed}),
    );
    assert_eq!(work(&store.workspace().unwrap(), "old"), &source);
    let archive = store.export_data("instance", "old").unwrap();
    let preview = store
        .preview_work_import(&archive.name, &archive.bytes)
        .unwrap();
    assert!(preview.duplicate);
    assert!(store.commit_import(&preview.token, false).is_err());
    let restored = store.commit_import(&preview.token, true).unwrap();
    assert_eq!(work(&restored, "old"), &source);
}
#[test]
fn any_work_status_can_be_used_as_a_prototype() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.work_workspace().unwrap();
    new_work(&mut store, "draft");
    repeat(&mut store, "draft", "from-draft", true);
    act(&mut store, json!({"type":"start_instance","id":"draft"}));
    repeat(&mut store, "draft", "from-running", true);
    act(
        &mut store,
        json!({"type":"record_result","id":"draft","outcome":"failed","reason":"重试"}),
    );
    repeat(&mut store, "draft", "from-failure", true);
    act(
        &mut store,
        json!({"type":"terminate_instance","id":"draft","reason":"停止"}),
    );
    let ws = repeat(&mut store, "draft", "from-terminated", true);
    for id in [
        "from-draft",
        "from-running",
        "from-failure",
        "from-terminated",
    ] {
        assert_eq!(work(&ws, id).status, Status::Draft);
        assert!(work(&ws, id).entries.is_empty());
    }
    assert!(store.apply(serde_json::from_value(json!({"type":"repeat_work","id":"FROM-DRAFT","name":"碰撞","sourceId":"draft","carryValues":true})).unwrap()).is_err());
}
#[test]
fn old_templates_are_transactionally_preserved_as_work_without_duplicate_generation() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let before = store.workspace().unwrap();
    let template = before.templates[0].clone();
    new_work(&mut store, &template.id);
    let existing = store.workspace().unwrap().instances.clone();
    let db = Connection::open(dir.path().join("checklist.sqlite3")).unwrap();
    let original: String = db
        .query_row("SELECT body FROM checklist_workspace WHERE id=1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let loaded = store.work_workspace().unwrap();
    let converted = loaded.converted_templates[&template.id].clone();
    assert_ne!(converted, template.id);
    assert!(loaded.workspace.templates.is_empty());
    for old in existing {
        assert_eq!(work(&loaded.workspace, &old.id), &old);
    }
    let converted_work = work(&loaded.workspace, &converted);
    assert_eq!(converted_work.document, template.document);
    assert_eq!(converted_work.created_at, template.created_at);
    assert_eq!(converted_work.status, Status::Draft);
    let backup: String = db
        .query_row(
            "SELECT original_body FROM checklist_work_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(backup, original);
    assert_eq!(store.work_workspace().unwrap().workspace, loaded.workspace);
    drop(store);
    let mut store = Store::open(dir.path()).unwrap();
    assert_eq!(store.work_workspace().unwrap().workspace, loaded.workspace);
    act(&mut store, json!({"type":"delete_instance","id":converted}));
    assert!(!store
        .work_workspace()
        .unwrap()
        .workspace
        .instances
        .iter()
        .any(|i| i.id == converted));
    assert_eq!(
        db.query_row("SELECT count(*) FROM checklist_work_migrations", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
}
#[test]
fn failed_conversion_commits_neither_work_changes_nor_backup() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let before = store.workspace().unwrap();
    let db = Connection::open(dir.path().join("checklist.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_work_conversion BEFORE UPDATE ON checklist_workspace BEGIN SELECT RAISE(ABORT,'injected conversion failure'); END;").unwrap();
    assert!(store.work_workspace().is_err());
    assert_eq!(store.workspace().unwrap(), before);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='checklist_work_migrations'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.execute_batch("DROP TRIGGER fail_work_conversion")
        .unwrap();
    assert!(store
        .work_workspace()
        .unwrap()
        .workspace
        .templates
        .is_empty());
}
#[test]
fn former_template_json_imports_directly_as_an_independent_unstarted_work() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let template = store.workspace().unwrap().templates[0].clone();
    let file = store.export_data("template", &template.id).unwrap();
    store.work_workspace().unwrap();
    let preview = store.preview_work_import(&file.name, &file.bytes).unwrap();
    assert_eq!(preview.kind, "instance");
    assert!(preview.duplicate);
    let ws = store.commit_import(&preview.token, true).unwrap();
    assert!(ws.templates.is_empty());
    let imported = ws.instances.iter().find(|i| i.id != template.id).unwrap();
    assert_eq!(imported.document, template.document);
    assert_eq!(imported.status, Status::Draft);
    assert!(imported.entries.is_empty());
}
