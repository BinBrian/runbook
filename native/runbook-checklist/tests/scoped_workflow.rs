use runbook_checklist::{archive, validate, *};
use serde_json::{json, Value};

fn document() -> Document {
    serde_json::from_value(json!({
        "parameters":[
            {"id":"env","name":"环境","description":"","defaultValue":"release"},
            {"id":"player1","name":"玩家 ID","description":"","defaultValue":"1001","ownerId":"g1"},
            {"id":"player2","name":"玩家 ID","description":"","defaultValue":"2002","ownerId":"g2"},
            {"id":"branch","name":"来源分支","description":"","defaultValue":"preview","ownerId":"s1"},
            {"id":"futureOnly","name":"后续通知","description":"","defaultValue":"检查账号","ownerId":"g1"}
        ],
        "groups":[{"id":"g1","name":"第一个玩家"},{"id":"g2","name":"第二个玩家","sourceBlockId":"deleted-library-block"}],
        "steps":[
            {"id":"s1","groupId":"g1","title":["检查 ",{"parameterId":"player1"}],"description":[],"commands":[{"id":"c1","text":["check ",{"parameterId":"env"}," ",{"parameterId":"player1"}," ",{"parameterId":"branch"}]}]},
            {"id":"s2","groupId":"g1","title":["导入 ",{"parameterId":"player1"}],"description":[],"commands":[]},
            {"id":"s3","groupId":"g1","title":["通知 ",{"parameterId":"player1"}],"description":[{"parameterId":"futureOnly"}],"commands":[]},
            {"id":"s4","groupId":"g2","title":["检查 ",{"parameterId":"player2"}],"description":[],"commands":[]},
            {"id":"s5","groupId":"g2","title":["通知 ",{"parameterId":"player2"}],"description":[],"commands":[]},
            {"id":"tail","title":["结束"],"description":[],"commands":[]}
        ]
    })).unwrap()
}
fn apply(store: &mut Store, action: Value) -> Workspace {
    store
        .apply(serde_json::from_value(action).unwrap())
        .unwrap()
}
fn begin(store: &mut Store) -> Instance {
    store
        .apply(Action::CreateTemplate {
            id: "scoped".into(),
            name: "分组".into(),
            document: document(),
        })
        .unwrap();
    apply(
        store,
        json!({"type":"create_instance","id":"run","templateId":"scoped","name":"run"}),
    );
    apply(store, json!({"type":"start_instance","id":"run"})).instances[0].clone()
}
fn result(store: &mut Store, outcome: &str) -> Instance {
    apply(store, json!({"type":"record_result","id":"run","outcome":outcome,"reason":if outcome == "completed" { None } else { Some("人工记录") }})).instances[0].clone()
}

#[test]
fn local_visibility_and_group_shape_are_validated_by_identity() {
    let valid = document();
    validate::document(&valid).unwrap();
    let mut cross_group = valid.clone();
    cross_group.steps[0].title = vec![TextPart::Parameter(ParameterRef {
        parameter_id: "player2".into(),
    })];
    assert!(validate::document(&cross_group).is_err());
    let mut cross_step = valid.clone();
    cross_step.steps[1].title = vec![TextPart::Parameter(ParameterRef {
        parameter_id: "branch".into(),
    })];
    assert!(validate::document(&cross_step).is_err());
    let mut missing_owner = valid.clone();
    missing_owner.parameters[1].owner_id = Some("absent".into());
    assert!(validate::document(&missing_owner).is_err());
    let mut non_contiguous = valid.clone();
    non_contiguous.steps.swap(2, 3);
    assert!(validate::document(&non_contiguous).is_err());
    let mut empty_group = valid.clone();
    empty_group.groups.push(Group {
        id: "empty".into(),
        name: "空组".into(),
        description: String::new(),
        source_block_id: None,
    });
    assert!(validate::document(&empty_group).is_err());
    let mut collision = valid;
    collision.groups[0].id = "s1".into();
    assert!(validate::document(&collision).is_err());
}

#[test]
fn local_values_freeze_when_their_owner_advances_while_partial_group_can_continue() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    begin(&mut store);
    let failed = result(&mut store, "failed");
    let mut values = failed.parameter_values.clone();
    values.insert("branch".into(), "changed-before-advance".into());
    store
        .apply(Action::ApplyParameters {
            id: "run".into(),
            values,
        })
        .unwrap();
    let first = result(&mut store, "completed");
    let history = first.entries.clone();
    let mut values = first.parameter_values.clone();
    values.insert("branch".into(), "forbidden".into());
    assert!(store
        .apply(Action::ApplyParameters {
            id: "run".into(),
            values
        })
        .is_err());
    let mut values = first.parameter_values.clone();
    values.insert("player1".into(), "1009".into());
    values.insert("player2".into(), "2009".into());
    store
        .apply(Action::ApplyParameters {
            id: "run".into(),
            values,
        })
        .unwrap();
    let second = result(&mut store, "completed");
    assert_eq!(second.entries[..history.len()], history);
    let third = result(&mut store, "skipped");
    let mut values = third.parameter_values.clone();
    values.insert("player1".into(), "forbidden".into());
    assert!(store
        .apply(Action::ApplyParameters {
            id: "run".into(),
            values
        })
        .is_err());
    let mut values = third.parameter_values.clone();
    values.insert("env".into(), "sandboxa".into());
    values.insert("player2".into(), "2020".into());
    let changed = store
        .apply(Action::ApplyParameters {
            id: "run".into(),
            values,
        })
        .unwrap();
    assert_eq!(changed.instances[0].entries, third.entries);
}

#[test]
fn progressed_group_identity_freezes_but_future_members_remain_editable() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    begin(&mut store);
    let advanced = result(&mut store, "completed");
    let save = |doc| Action::SaveInstance {
        id: "run".into(),
        name: "run".into(),
        document: doc,
    };
    let mut renamed = advanced.document.clone();
    renamed.groups[0].name = "改历史组".into();
    assert!(store.apply(save(renamed)).is_err());
    let mut description = advanced.document.clone();
    description.groups[0].description = "不能补改已推进组的流程说明".into();
    assert!(store.apply(save(description)).is_err());
    assert_eq!(store.workspace().unwrap().instances[0], advanced);
    let mut future_description = advanced.document.clone();
    future_description.groups[1].description = "未推进组允许补充说明\n按实际结果记录".into();
    let future_changed = store.apply(save(future_description)).unwrap();
    assert_eq!(future_changed.instances[0].entries, advanced.entries);
    assert_eq!(
        future_changed.instances[0].document.groups[1].description,
        "未推进组允许补充说明\n按实际结果记录"
    );
    let mut moved = advanced.document.clone();
    moved.steps[1].group_id = None;
    moved.steps.remove(2);
    assert!(store.apply(save(moved)).is_err());
    let mut definition = advanced.document.clone();
    definition.parameters[1].default_value = "change".into();
    assert!(store.apply(save(definition)).is_err());
    let mut future_definition = advanced.document.clone();
    future_definition.parameters[4].name = "仅后续使用，可以修改定义".into();
    future_definition.parameters[4].default_value = "新默认值".into();
    assert!(store.apply(save(future_definition)).is_ok());
    let mut future = advanced.document.clone();
    let mut added = future.steps[2].clone();
    added.id = "future-new".into();
    future.steps.insert(3, added);
    future.steps.swap(2, 3);
    future.steps.remove(3);
    let changed = store.apply(save(future)).unwrap();
    assert_eq!(changed.instances[0].entries, advanced.entries);
    assert_eq!(changed.instances[0].document.steps[2].id, "future-new");
}

fn block_document() -> Document {
    serde_json::from_value(json!({
        "groups":[{"id":"restart","name":"更新重启服务"}],
        "parameters":[{"id":"env","name":"环境","description":"","defaultValue":"sandboxa","ownerId":"restart"}],
        "steps":[{"id":"stop","groupId":"restart","title":["停止"],"description":[],"commands":[{"id":"stop-command","text":["stopserver ",{"parameterId":"env"}," all"]}]}]
    })).unwrap()
}

fn untitled_document() -> Document {
    serde_json::from_value(json!({
        "groups":[{"id":"untitled-group","name":"","description":""}],
        "parameters":[],
        "steps":[{"id":"untitled-step","groupId":"untitled-group","title":[""],"description":[""],"commands":[]}]
    })).unwrap()
}

#[test]
fn group_titles_may_be_empty_but_keep_the_utf8_byte_and_nul_limits() {
    let mut doc = untitled_document();
    validate::document(&doc).unwrap();
    doc.groups[0].name = "  \n  ".into();
    validate::document(&doc).unwrap();
    doc.groups[0].name = "😀".repeat(256);
    assert_eq!(doc.groups[0].name.len(), 1024);
    validate::document(&doc).unwrap();
    doc.groups[0].name.push('x');
    assert!(validate::document(&doc).is_err());
    doc.groups[0].name = "name\0invalid".into();
    assert!(validate::document(&doc).is_err());
    doc.groups[0].name.clear();
    doc.steps[0].title.clear();
    assert!(validate::document(&doc).is_err());
    doc.steps[0].title.push(TextPart::Text(String::new()));
    validate::document(&doc).unwrap();
}

#[test]
fn untitled_content_survives_sqlite_results_and_complete_archive_roundtrips_without_placeholders() {
    let source_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(source_dir.path()).unwrap();
    let doc = untitled_document();
    store
        .apply(Action::CreateTemplate {
            id: "empty-template".into(),
            name: "内容留空的模板".into(),
            document: doc.clone(),
        })
        .unwrap();
    store
        .apply(Action::CreateBlock {
            id: "empty-block".into(),
            name: "内容留空的复用块".into(),
            document: doc.clone(),
        })
        .unwrap();
    apply(
        &mut store,
        json!({"type":"create_instance","id":"empty-instance","templateId":"empty-template","name":"内容留空的实例"}),
    );
    apply(
        &mut store,
        json!({"type":"start_instance","id":"empty-instance"}),
    );
    let completed = apply(
        &mut store,
        json!({"type":"record_result","id":"empty-instance","outcome":"completed"}),
    );
    let instance = completed
        .instances
        .iter()
        .find(|value| value.id == "empty-instance")
        .unwrap();
    assert_eq!(instance.document, doc);
    match &instance.entries[0] {
        Entry::Result { snapshot, .. } => {
            assert!(snapshot.title.is_empty());
            assert!(snapshot.description.is_empty());
        }
        _ => panic!("result expected"),
    }
    let before = store.workspace().unwrap();
    drop(store);
    let store = Store::open(source_dir.path()).unwrap();
    assert_eq!(store.workspace().unwrap(), before);

    let target_dir = tempfile::tempdir().unwrap();
    let mut target = Store::open(target_dir.path()).unwrap();
    for (kind, id) in [
        ("template", "empty-template"),
        ("block", "empty-block"),
        ("instance", "empty-instance"),
    ] {
        let export = store.export_data(kind, id).unwrap();
        let imported = archive::parse(&export.name, &export.bytes).unwrap();
        let restored_doc = match imported.value {
            archive::Imported::Template(value) | archive::Imported::Block(value) => value.document,
            archive::Imported::Instance(value) => {
                assert_eq!(value.entries, instance.entries);
                value.document
            }
        };
        assert_eq!(restored_doc, doc);
        let serialized = serde_json::to_string(&restored_doc).unwrap();
        for placeholder in ["新步骤", "步骤标题", "未命名", "添加描述"] {
            assert!(!serialized.contains(placeholder));
        }
        let preview = target.preview_import(&export.name, &export.bytes).unwrap();
        assert!(!preview.duplicate);
        target.commit_import(&preview.token, false).unwrap();
    }
    let restored = target.workspace().unwrap();
    assert_eq!(
        restored
            .templates
            .iter()
            .find(|value| value.id == "empty-template")
            .unwrap()
            .document,
        doc
    );
    assert_eq!(
        restored
            .blocks
            .iter()
            .find(|value| value.id == "empty-block")
            .unwrap()
            .document,
        doc
    );
    assert_eq!(
        restored
            .instances
            .iter()
            .find(|value| value.id == "empty-instance")
            .unwrap(),
        instance
    );
    drop(target);
    assert_eq!(
        Store::open(target_dir.path()).unwrap().workspace().unwrap(),
        restored
    );
}

#[test]
fn allowing_untitled_groups_does_not_relax_artifact_or_parameter_names() {
    let doc = untitled_document();
    let at = now();
    let mut template = Template {
        favorite: None,
        format_version: 2,
        kind: "template".into(),
        id: "template".into(),
        name: "保留必填名称".into(),
        document: doc.clone(),
        created_at: at.clone(),
        updated_at: at,
    };
    validate::template(&template).unwrap();
    for invalid_name in ["", "  \n  "] {
        template.name = invalid_name.into();
        assert!(validate::template(&template).is_err());
        template.kind = "block".into();
        assert!(validate::block(&template).is_err());
        template.kind = "template".into();
    }
    let mut parameter_doc = serde_json::to_value(&doc).unwrap();
    parameter_doc["parameters"] = json!([{"id":"empty-parameter","name":"","description":"","defaultValue":"","ownerId":"untitled-step"}]);
    assert!(
        validate::document(&serde_json::from_value::<Document>(parameter_doc).unwrap()).is_err()
    );
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    store
        .apply(Action::CreateTemplate {
            id: "template".into(),
            name: "保留必填名称".into(),
            document: doc,
        })
        .unwrap();
    let before = store.workspace().unwrap();
    for invalid_name in ["", "  \n  "] {
        assert!(store
            .apply(Action::CreateInstance {
                id: "invalid-instance".into(),
                template_id: Some("template".into()),
                from_instance_id: None,
                name: invalid_name.into(),
            })
            .is_err());
        assert_eq!(store.workspace().unwrap(), before);
    }
}

#[test]
fn group_description_is_literal_multiline_text_with_the_step_text_byte_limit() {
    let mut doc = document();
    assert!(doc.groups.iter().all(|g| g.description.is_empty()));
    assert!(serde_json::to_value(&doc.groups[0])
        .unwrap()
        .get("description")
        .is_none());
    let multiline = "  更新前确认目标环境\r\n字面文本 {env}，不替换参数\n  保留空格  ";
    doc.groups[0].description = multiline.into();
    validate::document(&doc).unwrap();
    let encoded = serde_json::to_vec(&doc).unwrap();
    let restored: Document = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(restored.groups[0].description, multiline);
    doc.groups[0].description = "a".repeat(1024 * 1024);
    validate::document(&doc).unwrap();
    doc.groups[0].description.push('a');
    assert!(validate::document(&doc).is_err());
    doc.groups[0].description = "检".repeat(349_525);
    validate::document(&doc).unwrap();
    doc.groups[0].description.push('查');
    assert!(validate::document(&doc).is_err());
    doc.groups[0].description = "无效\0文本".into();
    assert!(validate::document(&doc).is_err());
}

#[test]
fn legacy_v2_groups_without_description_read_without_database_rewrite() {
    let directory = tempfile::tempdir().unwrap();
    drop(Store::open(directory.path()).unwrap());
    let mut doc = serde_json::to_value(document()).unwrap();
    for group in doc["groups"].as_array_mut().unwrap() {
        group.as_object_mut().unwrap().remove("description");
    }
    let body = serde_json::to_string(&json!({
        "templates":[{
            "formatVersion":2,"kind":"template","id":"legacy-group-description",
            "name":"旧版组","document":doc,
            "createdAt":"2026-10-14T00:00:00.000Z","updatedAt":"2026-10-14T00:00:00.000Z"
        }],"instances":[],"blocks":[]
    }))
    .unwrap();
    let connection =
        rusqlite::Connection::open(directory.path().join("checklist.sqlite3")).unwrap();
    connection
        .execute("UPDATE checklist_workspace SET body=?1 WHERE id=1", [&body])
        .unwrap();
    let store = Store::open(directory.path()).unwrap();
    let workspace = store.workspace().unwrap();
    let template = &workspace.templates[0];
    assert!(template
        .document
        .groups
        .iter()
        .all(|g| g.description.is_empty()));
    let export = store.export_data("template", &template.id).unwrap();
    let exported: Value = serde_json::from_slice(&export.bytes).unwrap();
    for group in exported["document"]["groups"].as_array().unwrap() {
        assert!(group.get("description").is_none());
    }
    let archive::Imported::Template(restored) =
        archive::parse(&export.name, &export.bytes).unwrap().value
    else {
        panic!("template expected");
    };
    assert_eq!(&restored, template);
    let after: String = connection
        .query_row(
            "SELECT body FROM checklist_workspace WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, body);
}

#[test]
fn group_descriptions_survive_save_sqlite_and_self_contained_archive_roundtrip() {
    let source_dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(source_dir.path()).unwrap();
    let mut doc = document();
    doc.groups[0].description = "玩家转区前\n核对玩家及区服".into();
    store
        .apply(Action::CreateTemplate {
            id: "description-template".into(),
            name: "含组说明模板".into(),
            document: doc.clone(),
        })
        .unwrap();
    doc.groups[1].description = "  第二个玩家独立操作\r\n{原样保留}  ".into();
    store
        .apply(Action::SaveTemplate {
            id: "description-template".into(),
            name: "含组说明模板".into(),
            document: doc.clone(),
        })
        .unwrap();
    store
        .apply(Action::CreateInstance {
            id: "description-instance".into(),
            template_id: Some("description-template".into()),
            from_instance_id: None,
            name: "含组说明实例".into(),
        })
        .unwrap();
    let mut block = block_document();
    block.groups[0].description = "先停服，再更新\n确认完毕后重新启动".into();
    store
        .apply(Action::CreateBlock {
            id: "description-block".into(),
            name: "服务更新块".into(),
            document: block.clone(),
        })
        .unwrap();
    block.groups[0].description.push_str("\n组内命令逐条记录");
    store
        .apply(Action::SaveBlock {
            id: "description-block".into(),
            name: "服务更新块".into(),
            document: block.clone(),
        })
        .unwrap();
    let before = store.workspace().unwrap();
    drop(store);
    let store = Store::open(source_dir.path()).unwrap();
    assert_eq!(store.workspace().unwrap(), before);

    let target_dir = tempfile::tempdir().unwrap();
    let mut target = Store::open(target_dir.path()).unwrap();
    for (kind, id, expected_doc) in [
        ("template", "description-template", &doc),
        ("instance", "description-instance", &doc),
        ("block", "description-block", &block),
    ] {
        let export = store.export_data(kind, id).unwrap();
        let parsed = archive::parse(&export.name, &export.bytes).unwrap();
        let parsed_doc = match parsed.value {
            archive::Imported::Template(value) | archive::Imported::Block(value) => value.document,
            archive::Imported::Instance(value) => value.document,
        };
        assert_eq!(&parsed_doc, expected_doc);
        let preview = target.preview_import(&export.name, &export.bytes).unwrap();
        assert!(!preview.duplicate);
        target.commit_import(&preview.token, false).unwrap();
    }
    let imported = target.workspace().unwrap();
    assert_eq!(
        imported
            .templates
            .iter()
            .find(|v| v.id == "description-template")
            .unwrap()
            .document,
        doc
    );
    assert_eq!(
        imported
            .instances
            .iter()
            .find(|v| v.id == "description-instance")
            .unwrap()
            .document,
        doc
    );
    assert_eq!(
        imported
            .blocks
            .iter()
            .find(|v| v.id == "description-block")
            .unwrap()
            .document,
        block
    );
    drop(target);
    assert_eq!(
        Store::open(target_dir.path()).unwrap().workspace().unwrap(),
        imported
    );
}

#[test]
fn block_library_roundtrip_is_independent_from_inserted_documents() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let seeded_blocks = store.workspace().unwrap().blocks.len();
    store
        .apply(Action::CreateBlock {
            id: "restart".into(),
            name: "更新重启服务".into(),
            document: block_document(),
        })
        .unwrap();
    let export = store.export_data("block", "restart").unwrap();
    let parsed = archive::parse(&export.name, &export.bytes).unwrap();
    assert!(matches!(parsed.value, archive::Imported::Block(_)));
    let preview = store.preview_import(&export.name, &export.bytes).unwrap();
    assert!(preview.duplicate);
    assert!(store.commit_import(&preview.token, false).is_err());
    let imported = store.commit_import(&preview.token, true).unwrap();
    assert_eq!(imported.blocks.len(), seeded_blocks + 2);
    assert_ne!(
        imported.blocks[seeded_blocks].id,
        imported.blocks[seeded_blocks + 1].id
    );
    let mut inserted = block_document();
    inserted.groups[0].source_block_id = Some("restart".into());
    store
        .apply(Action::CreateTemplate {
            id: "inserted".into(),
            name: "使用副本".into(),
            document: inserted.clone(),
        })
        .unwrap();
    apply(
        &mut store,
        json!({"type":"create_instance","id":"run","templateId":"inserted","name":"run"}),
    );
    let mut changed = block_document();
    changed.parameters[0].default_value = "sandboxb".into();
    store
        .apply(Action::SaveBlock {
            id: "restart".into(),
            name: "新版块".into(),
            document: changed,
        })
        .unwrap();
    store
        .apply(Action::DeleteBlock {
            id: "restart".into(),
        })
        .unwrap();
    assert_eq!(store.workspace().unwrap().instances[0].document, inserted);
    let instance = store.export_data("instance", "run").unwrap();
    let restored = archive::parse(&instance.name, &instance.bytes).unwrap();
    if let archive::Imported::Instance(instance) = restored.value {
        assert_eq!(instance.document, inserted);
    } else {
        panic!("instance expected");
    }
    let before = store.workspace().unwrap();
    drop(store);
    assert_eq!(
        Store::open(directory.path()).unwrap().workspace().unwrap(),
        before
    );
}

#[test]
fn block_requires_one_self_contained_group_and_local_parameters() {
    let document = block_document();
    let at = now();
    let block = Template {
        favorite: None,
        format_version: 2,
        kind: "block".into(),
        id: "block".into(),
        name: "块".into(),
        document,
        created_at: at.clone(),
        updated_at: at,
    };
    validate::block(&block).unwrap();
    let mut global = block.clone();
    global.document.parameters[0].owner_id = None;
    assert!(validate::block(&global).is_err());
    let mut ungrouped = block.clone();
    ungrouped.document.steps[0].group_id = None;
    assert!(validate::block(&ungrouped).is_err());
    let mut old_version = block;
    old_version.format_version = 1;
    assert!(validate::block(&old_version).is_err());
}

#[test]
fn v1_workspace_read_is_non_mutating_and_export_upgrades_without_rewriting_results() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    drop(store);
    let template: Value = serde_json::from_str(include_str!(
        "../../../docs/examples/patch-maintenance/template.runbook.json"
    ))
    .unwrap();
    let instance: Value = serde_json::from_str(include_str!(
        "../../../docs/examples/patch-maintenance/runbook.json"
    ))
    .unwrap();
    let body =
        serde_json::to_string(&json!({"templates":[template],"instances":[instance]})).unwrap();
    let connection =
        rusqlite::Connection::open(directory.path().join("checklist.sqlite3")).unwrap();
    connection
        .execute("UPDATE checklist_workspace SET body=?1 WHERE id=1", [&body])
        .unwrap();
    let store = Store::open(directory.path()).unwrap();
    let workspace = store.workspace().unwrap();
    assert!(workspace.blocks.is_empty());
    assert_eq!(workspace.instances[0].format_version, 1);
    assert_eq!(
        connection
            .query_row::<String, _, _>(
                "SELECT body FROM checklist_workspace WHERE id=1",
                [],
                |row| row.get(0)
            )
            .unwrap(),
        body
    );
    let exported = store
        .export_data("template", &workspace.templates[0].id)
        .unwrap();
    if let archive::Imported::Template(template) = archive::parse(&exported.name, &exported.bytes)
        .unwrap()
        .value
    {
        assert_eq!(template.format_version, 2);
    } else {
        panic!("template expected");
    }
    // Historical entries are compared structurally; the export version change
    // does not synthesize, re-render, or modify any old result snapshot.
    let mut upgraded = workspace.instances[0].clone();
    upgraded.format_version = 2;
    validate::instance(&upgraded).unwrap();
    assert_eq!(upgraded.entries, workspace.instances[0].entries);
}

#[test]
fn v1_cannot_smuggle_scoped_fields_and_import_enforces_scopes() {
    let at = now();
    let mut template = Template {
        favorite: None,
        format_version: 1,
        kind: "template".into(),
        id: "test".into(),
        name: "test".into(),
        document: document(),
        created_at: at.clone(),
        updated_at: at,
    };
    assert!(validate::template(&template).is_err());
    template.format_version = 2;
    validate::template(&template).unwrap();
    template.document.steps[0].title = vec![TextPart::Parameter(ParameterRef {
        parameter_id: "player2".into(),
    })];
    assert!(archive::parse("bad.runbook.json", &serde_json::to_vec(&template).unwrap()).is_err());
}

#[test]
fn supplied_scoped_templates_and_blocks_parse_and_render_independent_environments() {
    for (name, source) in [
        (
            "restart.runbook.json",
            include_bytes!("../../../docs/examples/blocks/restart-services.runbook.json")
                .as_slice(),
        ),
        (
            "transfer.runbook.json",
            include_bytes!("../../../docs/examples/blocks/transfer-player.runbook.json").as_slice(),
        ),
        (
            "maintenance.runbook.json",
            include_bytes!("../../../templates/release-maintenance/maintenance.runbook.json")
                .as_slice(),
        ),
    ] {
        archive::parse(name, source).unwrap();
    }
    let source = include_bytes!("../../../docs/examples/blocks/four-environments.runbook.json");
    let parsed = archive::parse("four.runbook.json", source).unwrap();
    let archive::Imported::Template(template) = parsed.value else {
        panic!("template expected");
    };
    assert_eq!(template.document.groups.len(), 4);
    let values: Values = template
        .document
        .parameters
        .iter()
        .map(|p| (p.id.clone(), p.default_value.clone()))
        .collect();
    let commands: Vec<_> = template
        .document
        .steps
        .iter()
        .flat_map(|s| &s.commands)
        .map(|c| resolve(&c.text, &values))
        .collect();
    let expected: Vec<_> = ["sandboxa", "sandboxb", "sandboxc", "sandboxd"]
        .into_iter()
        .flat_map(|env| {
            [
                format!("stopserver {env} all"),
                format!("publishgame {env}"),
                format!("syncgame {env} all"),
                format!("startserver {env} all"),
            ]
        })
        .collect();
    assert_eq!(commands, expected);
}
