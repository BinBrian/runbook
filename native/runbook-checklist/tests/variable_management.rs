use runbook_checklist::*;
use serde_json::json;

const WORK: &str = "variable-work";

fn document() -> Document {
    serde_json::from_value(json!({
        "groups":[{"id":"group","name":"当前步骤组"}],
        "parameters":[
            {"id":"global","name":"环境","description":"全局","defaultValue":"sandbox-a"},
            {"id":"group-local","ownerId":"group","name":"目标","description":"组定义","defaultValue":"default-target"},
            {"id":"step-local","ownerId":"first","name":"版本","description":"步骤定义","defaultValue":"default-version"},
            {"id":"past-unused","ownerId":"intro","name":"已推进所属变量","description":"","defaultValue":""},
            {"id":"future-unused","ownerId":"second","name":"目标","description":"同名不同身份","defaultValue":""}
        ],
        "steps":[
            {"id":"intro","title":["前置检查"],"description":[],"commands":[{"id":"intro-command","text":["check ",{"parameterId":"global"}]}]},
            {"id":"first","groupId":"group","title":["部署 ",{"parameterId":"group-local"}],"description":[{"parameterId":"step-local"}],"commands":[{"id":"deploy-command","text":["deploy ",{"parameterId":"global"}," ",{"parameterId":"group-local"}," ",{"parameterId":"step-local"}]}]},
            {"id":"second","groupId":"group","title":["确认 ",{"parameterId":"group-local"}],"description":[],"commands":[]},
            {"id":"tail","title":["收尾"],"description":[],"commands":[]}
        ]
    }))
    .unwrap()
}

fn act(store: &mut Store, action: serde_json::Value) -> Instance {
    let workspace = store
        .apply(serde_json::from_value(action).unwrap())
        .unwrap();
    workspace
        .instances
        .into_iter()
        .find(|instance| instance.id == WORK)
        .unwrap()
}

fn current(store: &Store) -> Instance {
    store
        .workspace()
        .unwrap()
        .instances
        .into_iter()
        .find(|instance| instance.id == WORK)
        .unwrap()
}

fn create(store: &mut Store) -> Instance {
    act(
        store,
        json!({"type":"create_work","id":WORK,"name":"变量管理验收","document":document()}),
    );
    let mut values = current(store).parameter_values;
    values.insert("group-local".into(), "actual-target".into());
    values.insert("step-local".into(), "actual-version".into());
    act(
        store,
        json!({"type":"apply_parameters","id":WORK,"values":values}),
    )
}

fn save(document: Document) -> Action {
    Action::SaveInstance {
        id: WORK.into(),
        name: "变量管理验收".into(),
        document,
    }
}

fn record(store: &mut Store, outcome: &str) -> Instance {
    act(
        store,
        json!({"type":"record_result","id":WORK,"outcome":outcome,"reason":if outcome == "completed" { None } else { Some("人工核对") }}),
    )
}

fn assert_archive_roundtrip(store: &Store, expected: &Instance) {
    let export = store.export_data("instance", WORK).unwrap();
    let parsed = archive::parse(&export.name, &export.bytes).unwrap();
    match parsed.value {
        archive::Imported::Instance(instance) => assert_eq!(&instance, expected),
        _ => panic!("work archive expected"),
    }
    let target_dir = tempfile::tempdir().unwrap();
    let mut target = Store::open(target_dir.path()).unwrap();
    let preview = target
        .preview_work_import(&export.name, &export.bytes)
        .unwrap();
    assert!(!preview.duplicate);
    target.commit_import(&preview.token, false).unwrap();
    assert_eq!(current(&target), *expected);
    drop(target);
    assert_eq!(current(&Store::open(target_dir.path()).unwrap()), *expected);
}

// This is the document sent by the UI after the user confirms effective-text deletion.
fn resolved_deletion(instance: &Instance, ids: &[&str]) -> Document {
    let mut document = instance.document.clone();
    document
        .parameters
        .retain(|parameter| !ids.contains(&parameter.id.as_str()));
    for step in &mut document.steps {
        for parts in std::iter::once(&mut step.title)
            .chain(std::iter::once(&mut step.description))
            .chain(step.commands.iter_mut().map(|command| &mut command.text))
        {
            for part in parts {
                if let TextPart::Parameter(reference) = part {
                    if ids.contains(&reference.parameter_id.as_str()) {
                        *part = TextPart::Text(
                            instance.parameter_values[&reference.parameter_id].clone(),
                        );
                    }
                }
            }
        }
    }
    document
}

#[test]
fn promoting_group_and_step_variables_keeps_ids_definitions_values_and_references_across_storage() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let before = create(&mut store);
    let mut promoted = before.document.clone();
    for parameter in &mut promoted.parameters {
        if ["group-local", "step-local"].contains(&parameter.id.as_str()) {
            parameter.owner_id = None;
        }
    }
    store.apply(save(promoted.clone())).unwrap();
    let after = current(&store);
    assert_eq!(after.parameter_values, before.parameter_values);
    assert_eq!(after.document.steps, before.document.steps);
    assert_eq!(after.document, promoted);
    assert_eq!(after.document.parameters[1].default_value, "default-target");
    assert_eq!(
        after.document.parameters[2].default_value,
        "default-version"
    );
    assert_eq!(after.document.parameters[4], before.document.parameters[4]);
    assert!(after.entries.is_empty());

    promoted.steps[3].description = vec![TextPart::Parameter(ParameterRef {
        parameter_id: "step-local".into(),
    })];
    store.apply(save(promoted)).unwrap();
    let expected = current(&store);
    assert_eq!(
        snapshot(&expected.document.steps[3], &expected.parameter_values).description,
        "actual-version"
    );
    drop(store);
    let reopened = Store::open(directory.path()).unwrap();
    assert_eq!(current(&reopened), expected);
    assert_archive_roundtrip(&reopened, &expected);
}

#[test]
fn bulk_deletion_preserves_effective_text_and_history_but_removes_only_selected_live_values() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    create(&mut store);
    act(&mut store, json!({"type":"start_instance","id":WORK}));
    record(&mut store, "completed");
    let before = record(&mut store, "failed");
    let document = resolved_deletion(&before, &["group-local", "step-local", "future-unused"]);
    store.apply(save(document.clone())).unwrap();
    let after = current(&store);
    assert_eq!(after.current_step_id.as_deref(), Some("first"));
    assert_eq!(after.entries, before.entries);
    assert_eq!(after.document, document);
    assert_eq!(after.parameter_values.len(), 2);
    assert_eq!(after.parameter_values["global"], "sandbox-a");
    assert!(after.parameter_values.contains_key("past-unused"));
    for (old, changed) in before.document.steps.iter().zip(&after.document.steps) {
        let old = snapshot(old, &before.parameter_values);
        let changed = snapshot(changed, &after.parameter_values);
        assert_eq!(changed.title, old.title);
        assert_eq!(changed.description, old.description);
        assert_eq!(changed.commands, old.commands);
    }
    let advanced = record(&mut store, "completed");
    assert_eq!(advanced.entries[..before.entries.len()], before.entries);
    match advanced.entries.last().unwrap() {
        Entry::Result { snapshot, .. } => {
            assert_eq!(
                snapshot.commands[0].text,
                "deploy sandbox-a actual-target actual-version"
            );
            assert!(!snapshot.parameter_values.contains_key("group-local"));
        }
        _ => panic!("result expected"),
    }
    drop(store);
    let reopened = Store::open(directory.path()).unwrap();
    assert_eq!(current(&reopened), advanced);
    assert_archive_roundtrip(&reopened, &advanced);
}

#[test]
fn frozen_scope_or_deletion_rejects_the_whole_edit_and_keeps_recorded_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    create(&mut store);
    act(&mut store, json!({"type":"start_instance","id":WORK}));
    let intro_done = record(&mut store, "completed");
    let mut promoted = intro_done.document.clone();
    promoted
        .parameters
        .iter_mut()
        .find(|p| p.id == "past-unused")
        .unwrap()
        .owner_id = None;
    assert!(store.apply(save(promoted)).is_err());
    assert_eq!(current(&store), intro_done);
    let deleted = resolved_deletion(&intro_done, &["global", "group-local", "past-unused"]);
    assert!(store.apply(save(deleted)).is_err());
    assert_eq!(current(&store), intro_done);

    let group_started = record(&mut store, "completed");
    let mut promoted = group_started.document.clone();
    promoted
        .parameters
        .iter_mut()
        .find(|p| p.id == "group-local")
        .unwrap()
        .owner_id = None;
    assert!(store.apply(save(promoted)).is_err());
    assert_eq!(current(&store), group_started);
    let mut removed_definition = group_started.document.clone();
    removed_definition
        .parameters
        .retain(|p| p.id != "past-unused");
    assert!(store.apply(save(removed_definition)).is_err());
    assert_eq!(current(&store), group_started);
    drop(store);
    assert_eq!(
        current(&Store::open(directory.path()).unwrap()),
        group_started
    );
}

#[test]
fn dangling_batch_deletion_is_rejected_without_losing_any_definitions_or_values() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let before = create(&mut store);
    let mut invalid = before.document.clone();
    invalid
        .parameters
        .retain(|parameter| !["group-local", "future-unused"].contains(&parameter.id.as_str()));
    assert!(store.apply(save(invalid)).is_err());
    assert_eq!(current(&store), before);
    drop(store);
    assert_eq!(current(&Store::open(directory.path()).unwrap()), before);
}

#[test]
fn deleting_explicit_empty_references_leaves_valid_plain_text_and_can_be_saved() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let before = create(&mut store);
    let mut values = before.parameter_values.clone();
    values.insert("group-local".into(), String::new());
    let empty = act(
        &mut store,
        json!({"type":"apply_parameters","id":WORK,"values":values}),
    );
    let removed = resolved_deletion(&empty, &["group-local", "future-unused"]);
    store.apply(save(removed.clone())).unwrap();
    let after = current(&store);
    assert_eq!(after.document, removed);
    assert!(!after.parameter_values.contains_key("group-local"));
    assert_eq!(
        snapshot(&after.document.steps[1], &after.parameter_values).title,
        "部署 "
    );
    assert_eq!(
        snapshot(&after.document.steps[1], &after.parameter_values).commands[0].text,
        "deploy sandbox-a  actual-version"
    );
    assert_archive_roundtrip(&store, &after);
}
