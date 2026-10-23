use runbook_checklist::*;
use serde_json::{json, Value};

fn act(store: &mut Store, value: Value) -> Workspace {
    store.apply(serde_json::from_value(value).unwrap()).unwrap()
}
fn setup(store: &mut Store) {
    for block in store.workspace().unwrap().blocks {
        act(store, json!({"type":"delete_block","id":block.id}));
    }
    act(
        store,
        json!({"type":"create_work","id":"work","name":"维护来源","document":{
          "groups":[{"id":"g","name":"玩家转区","description":"按玩家核对"}],
          "parameters":[
            {"id":"env","name":"环境","description":"全局","defaultValue":"release"},
            {"id":"player","ownerId":"g","name":"玩家","description":"组变量","defaultValue":"123"},
            {"id":"local","ownerId":"a","name":"局部","description":"步骤","defaultValue":"old"},
            {"id":"unused","name":"未引用全局","description":"","defaultValue":"omit"}],
          "steps":[
            {"id":"a","groupId":"g","title":["玩家",{"parameterId":"player"}],"description":[{"parameterId":"local"}],"commands":[{"id":"cmd","text":["check ",{"parameterId":"env"}]}]},
            {"id":"b","groupId":"g","title":["第二步"],"description":[],"commands":[]},
            {"id":"c","title":["三"],"description":[],"commands":[]},
            {"id":"d","title":["四"],"description":[],"commands":[]}]
        }}),
    );
}
fn capture(store: &mut Store, id: &str, step: Option<&str>, group: Option<&str>) -> Workspace {
    act(
        store,
        json!({"type":"capture_favorite","id":id,"name":"收藏","sourceId":"work","stepId":step,"groupId":group,"replaceId":null}),
    )
}
#[test]
fn single_favorite_localizes_dependencies_keeps_defaults_and_excludes_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    setup(&mut store);
    act(
        &mut store,
        json!({"type":"apply_parameters","id":"work","values":{"env":"preview","player":"456","local":"new","unused":"omit"}}),
    );
    act(&mut store, json!({"type":"start_instance","id":"work"}));
    act(
        &mut store,
        json!({"type":"record_result","id":"work","outcome":"completed","reason":null}),
    );
    act(
        &mut store,
        json!({"type":"add_comment","id":"work","stepId":"a","entryId":"comment","text":"现场备注"}),
    );
    let original = store.workspace().unwrap().instances[0].clone();
    let ws = capture(&mut store, "single", Some("a"), None);
    let item = &ws.blocks[0];
    assert_eq!(ws.instances[0], original);
    assert_eq!(item.favorite.as_ref().unwrap().kind, FavoriteKind::Step);
    assert_eq!(item.document.parameters.len(), 3);
    let step = &item.document.steps[0];
    assert_ne!(step.id, "a");
    assert_ne!(step.commands[0].id, "cmd");
    assert!(item
        .document
        .parameters
        .iter()
        .all(|p| p.owner_id.as_deref() == Some(step.id.as_str())));
    assert_eq!(
        item.document
            .parameters
            .iter()
            .find(|p| p.name == "环境")
            .unwrap()
            .default_value,
        "release"
    );
    let file = store.export_data("block", "single").unwrap();
    let text = String::from_utf8(file.bytes.clone()).unwrap();
    assert!(!text.contains("现场备注"));
    assert!(!text.contains("parameterValues"));
    assert!(!text.contains("preview"));
    let mut other = Store::open(tempfile::tempdir().unwrap().path()).unwrap();
    let preview = other.preview_work_import(&file.name, &file.bytes).unwrap();
    let imported = other.commit_import(&preview.token, false).unwrap();
    assert_eq!(
        imported.blocks.iter().find(|b| b.id == "single").unwrap(),
        item
    );
}
#[test]
fn group_favorite_keeps_scope_and_replaces_only_on_explicit_request() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    setup(&mut store);
    let ws = capture(&mut store, "f", None, Some("g"));
    let old = ws.blocks[0].clone();
    let doc = &old.document;
    assert_eq!(doc.steps.len(), 2);
    assert_eq!(doc.groups[0].description, "按玩家核对");
    assert_eq!(
        doc.parameters
            .iter()
            .find(|p| p.name == "环境")
            .unwrap()
            .owner_id
            .as_deref(),
        Some(doc.groups[0].id.as_str())
    );
    assert_eq!(
        doc.parameters
            .iter()
            .find(|p| p.name == "局部")
            .unwrap()
            .owner_id
            .as_deref(),
        Some(doc.steps[0].id.as_str())
    );
    let mut changed = ws.instances[0].document.clone();
    changed.steps[0].description = vec![TextPart::Text("新说明".into())];
    act(
        &mut store,
        json!({"type":"save_instance","id":"work","name":"来源已改","document":changed}),
    );
    assert_eq!(store.workspace().unwrap().blocks[0], old);
    let ws = act(
        &mut store,
        json!({"type":"capture_favorite","id":"unused-new","name":"更新","sourceId":"work","stepId":"a","groupId":null,"replaceId":"f"}),
    );
    assert_eq!(ws.blocks.len(), 1);
    assert_eq!(ws.blocks[0].id, "f");
    assert_eq!(ws.blocks[0].created_at, old.created_at);
    assert_eq!(
        ws.blocks[0].favorite.as_ref().unwrap().kind,
        FavoriteKind::Step
    );
    let document = ws.blocks[0].document.clone();
    act(
        &mut store,
        json!({"type":"rename_favorite","id":"f","name":"新名字"}),
    );
    assert_eq!(store.workspace().unwrap().blocks[0].document, document);
    drop(store);
    let mut reopened = Store::open(dir.path()).unwrap();
    assert_eq!(reopened.workspace().unwrap().blocks[0].name, "新名字");
    act(&mut reopened, json!({"type":"delete_block","id":"f"}));
    assert_eq!(reopened.workspace().unwrap().instances.len(), 1);
}
#[test]
fn invalid_capture_is_atomic_and_favorite_metadata_is_validated() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    setup(&mut store);
    let original = store.workspace().unwrap();
    for (step, group) in [(None, None), (Some("a"), Some("g")), (Some("gone"), None)] {
        let action=serde_json::from_value(json!({"type":"capture_favorite","id":"f","name":"收藏","sourceId":"work","stepId":step,"groupId":group,"replaceId":null})).unwrap();
        assert!(store.apply(action).is_err());
        assert_eq!(store.workspace().unwrap(), original);
    }
    let ws = capture(&mut store, "f", Some("a"), None);
    let mut invalid = serde_json::to_value(&ws.blocks[0]).unwrap();
    invalid["favorite"]["sourceStepIds"] = json!([]);
    assert!(store
        .preview_work_import(
            "invalid.runbook.json",
            serde_json::to_string(&invalid).unwrap().as_bytes()
        )
        .is_err());
}
#[test]
fn merging_future_steps_preserves_comments_and_current_step_is_frozen() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    setup(&mut store);
    act(&mut store, json!({"type":"start_instance","id":"work"}));
    act(
        &mut store,
        json!({"type":"add_comment","id":"work","stepId":"c","entryId":"note","text":"先补充的记录"}),
    );
    let original = store.workspace().unwrap().instances[0].clone();
    let mut merged = original.document.clone();
    merged
        .groups
        .push(serde_json::from_value(json!({"id":"merged","name":"","description":""})).unwrap());
    merged.steps[2].group_id = Some("merged".into());
    merged.steps[3].group_id = Some("merged".into());
    let ws = act(
        &mut store,
        json!({"type":"save_instance","id":"work","name":"合组","document":merged}),
    );
    assert_eq!(ws.instances[0].entries, original.entries);
    assert_eq!(ws.instances[0].parameter_values, original.parameter_values);
    assert_eq!(
        ws.instances[0]
            .document
            .steps
            .iter()
            .map(|s| &s.id)
            .collect::<Vec<_>>(),
        original
            .document
            .steps
            .iter()
            .map(|s| &s.id)
            .collect::<Vec<_>>()
    );
    let mut invalid = ws.instances[0].document.clone();
    invalid.steps[0].group_id = None;
    assert!(store
        .apply(
            serde_json::from_value(
                json!({"type":"save_instance","id":"work","name":"错误","document":invalid})
            )
            .unwrap()
        )
        .is_err());
    assert_eq!(store.workspace().unwrap(), ws);
}
