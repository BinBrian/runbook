use runbook_checklist::{archive, validate, *};
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
};

fn store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    (directory, store)
}
fn apply(store: &mut Store, value: serde_json::Value) -> Workspace {
    store.apply(serde_json::from_value(value).unwrap()).unwrap()
}
fn create(store: &mut Store, id: &str) -> Workspace {
    let template = store.workspace().unwrap().templates[0].id.clone();
    apply(
        store,
        serde_json::json!({"type":"create_instance","id":id,"templateId":template,"fromInstanceId":null,"name":"工作实例"}),
    )
}
fn fill_start(store: &mut Store, id: &str) {
    let mut values = store
        .workspace()
        .unwrap()
        .instances
        .iter()
        .find(|i| i.id == id)
        .unwrap()
        .parameter_values
        .clone();
    values.insert("packagePath".into(), "C:\\demo.zip".into());
    apply(
        store,
        serde_json::json!({"type":"apply_parameters","id":id,"values":values}),
    );
    apply(store, serde_json::json!({"type":"start_instance","id":id}));
}
fn result(store: &mut Store, id: &str, outcome: &str, reason: Option<&str>) -> Workspace {
    apply(
        store,
        serde_json::json!({"type":"record_result","id":id,"outcome":outcome,"reason":reason}),
    )
}
const IMAGE: &[u8] =
    include_bytes!("../../../docs/examples/patch-maintenance/images/package-check-demo.png");

#[test]
fn linear_results_parameters_and_frozen_prefix_are_enforced() {
    let (_dir, mut store) = store();
    create(&mut store, "work");
    assert!(store
        .apply(
            serde_json::from_value(serde_json::json!({"type":"start_instance","id":"work"}))
                .unwrap()
        )
        .is_err());
    fill_start(&mut store, "work");
    for outcome in ["failed", "skipped"] {
        assert!(store.apply(serde_json::from_value(serde_json::json!({"type":"record_result","id":"work","outcome":outcome,"reason":" "})).unwrap()).is_err());
    }
    result(&mut store, "work", "failed", Some("目标有误"));
    let first = store.workspace().unwrap().instances[0].entries[0].clone();
    let mut values = store.workspace().unwrap().instances[0]
        .parameter_values
        .clone();
    values.insert("environment".into(), "新环境".into());
    apply(
        &mut store,
        serde_json::json!({"type":"apply_parameters","id":"work","values":values}),
    );
    let workspace = result(&mut store, "work", "completed", None);
    assert_eq!(
        workspace.instances[0].current_step_id.as_deref(),
        Some("s2-package")
    );
    assert_eq!(workspace.instances[0].entries[0], first);
    let frozen = workspace.instances[0].document.steps[0].clone();
    let mut document = workspace.instances[0].document.clone();
    document.steps[0].title = vec![TextPart::Text("改写过去".into())];
    assert!(store
        .apply(Action::SaveInstance {
            id: "work".into(),
            name: "x".into(),
            document
        })
        .is_err());
    let mut document = workspace.instances[0].document.clone();
    document.parameters[0].name = "改名".into();
    assert!(store
        .apply(Action::SaveInstance {
            id: "work".into(),
            name: "x".into(),
            document
        })
        .is_err());
    let mut document = workspace.instances[0].document.clone();
    document.steps[1].description = vec![TextPart::Text("当前可以编辑".into())];
    document.steps.swap(3, 4);
    let workspace = store
        .apply(Action::SaveInstance {
            id: "work".into(),
            name: "x".into(),
            document,
        })
        .unwrap();
    assert_eq!(workspace.instances[0].document.steps[0], frozen);
    let mut values = workspace.instances[0].parameter_values.clone();
    values.insert("environment".into(), "后续环境".into());
    apply(
        &mut store,
        serde_json::json!({"type":"apply_parameters","id":"work","values":values}),
    );
    assert_eq!(
        store.workspace().unwrap().instances[0].entries[1],
        workspace.instances[0].entries[1]
    );
}

#[test]
fn completion_archive_supplements_copy_and_template_are_independent() {
    let (directory, mut store) = store();
    create(&mut store, "work");
    fill_start(&mut store, "work");
    for _ in 0..5 {
        result(&mut store, "work", "completed", None);
    }
    let completed = store.workspace().unwrap().instances[0].clone();
    assert_eq!(completed.status, Status::Completed);
    assert!(completed.archived_at.is_none());
    apply(
        &mut store,
        serde_json::json!({"type":"archive_instance","id":"work","archived":true}),
    );
    apply(
        &mut store,
        serde_json::json!({"type":"add_comment","id":"work","stepId":"s1-target","entryId":"comment","text":"归档后补充"}),
    );
    store
        .attach_image("work", "s1-target", "test.png", "image/png", IMAGE)
        .unwrap();
    assert!(store
        .read_image("work", "images/not-registered.png")
        .is_err());
    let data = store.export_data("instance", "work").unwrap();
    let preview = store.preview_import(&data.name, &data.bytes).unwrap();
    assert!(preview.duplicate);
    assert!(store.commit_import(&preview.token, false).is_err());
    let imported = store.commit_import(&preview.token, true).unwrap();
    assert_eq!(imported.instances.len(), 2);
    let copied = &imported.instances[1];
    assert_ne!(copied.id, "work");
    assert_eq!(copied.entries, imported.instances[0].entries);
    let image_path = copied
        .entries
        .iter()
        .find_map(|e| {
            if let Entry::Image { path, .. } = e {
                Some(path)
            } else {
                None
            }
        })
        .unwrap();
    assert!(store
        .read_image(&copied.id, image_path)
        .unwrap()
        .starts_with("data:image/png;base64,"));
    apply(
        &mut store,
        serde_json::json!({"type":"create_instance","id":"retry","templateId":null,"fromInstanceId":"work","name":"再做一次"}),
    );
    apply(
        &mut store,
        serde_json::json!({"type":"save_as_template","id":"work","templateId":"saved","name":"另存模板"}),
    );
    let workspace = store.workspace().unwrap();
    let retry = workspace
        .instances
        .iter()
        .find(|i| i.id == "retry")
        .unwrap();
    assert_eq!(retry.status, Status::Draft);
    assert!(retry.entries.is_empty());
    assert_eq!(retry.parameter_values, completed.parameter_values);
    assert_eq!(
        workspace.templates[1].document.parameters,
        workspace.templates[0].document.parameters
    );
    assert_eq!(workspace.templates[0].id, "demo-patch-template");
    drop(store);
    let reopened = Store::open(directory.path()).unwrap();
    assert_eq!(workspace, reopened.workspace().unwrap());
    assert!(!directory.path().join("runbook.sqlite3").exists());
}

#[test]
fn terminate_is_final_and_remaining_steps_are_not_skipped() {
    let (_directory, mut store) = store();
    create(&mut store, "work");
    fill_start(&mut store, "work");
    result(&mut store, "work", "completed", None);
    let workspace = apply(
        &mut store,
        serde_json::json!({"type":"terminate_instance","id":"work","reason":"取消维护"}),
    );
    let i = &workspace.instances[0];
    assert_eq!(i.status, Status::Terminated);
    assert_eq!(i.entries.len(), 1);
    assert!(i.archived_at.is_none());
    for action in [
        serde_json::json!({"type":"start_instance","id":"work"}),
        serde_json::json!({"type":"record_result","id":"work","outcome":"completed","reason":null}),
    ] {
        assert!(store
            .apply(serde_json::from_value(action).unwrap())
            .is_err());
    }
    assert!(store
        .apply(Action::ApplyParameters {
            id: "work".into(),
            values: BTreeMap::new()
        })
        .is_err());
    let entry_id = i.entries[0].id().to_string();
    assert!(store
        .apply(Action::DeleteEntry {
            id: "work".into(),
            entry_id
        })
        .is_err());
    let mut document = i.document.clone();
    document.steps[1].commands.clear();
    assert!(store
        .apply(Action::SaveInstance {
            id: "work".into(),
            name: "x".into(),
            document
        })
        .is_err());
    assert!(store
        .apply(Action::SaveInstance {
            id: "work".into(),
            name: "新名称".into(),
            document: i.document.clone()
        })
        .is_ok());
}

#[test]
fn template_edits_do_not_change_instances_and_new_references_require_filling() {
    let (_directory, mut store) = store();
    let workspace = create(&mut store, "work");
    let original = workspace.instances[0].document.clone();
    let mut document = original.clone();
    document.steps[0].title = vec![TextPart::Text("模板改了".into())];
    store
        .apply(Action::SaveTemplate {
            id: "demo-patch-template".into(),
            name: "模板".into(),
            document,
        })
        .unwrap();
    assert_eq!(store.workspace().unwrap().instances[0].document, original);
    fill_start(&mut store, "work");
    let mut document = original;
    document.parameters.push(Parameter {
        id: "extra".into(),
        name: "补充参数".into(),
        description: String::new(),
        default_value: String::new(),
        owner_id: None,
    });
    document.steps[0].description = vec![TextPart::Parameter(ParameterRef {
        parameter_id: "extra".into(),
    })];
    store
        .apply(Action::SaveInstance {
            id: "work".into(),
            name: "work".into(),
            document,
        })
        .unwrap();
    assert!(store
        .apply(Action::RecordResult {
            id: "work".into(),
            outcome: Outcome::Completed,
            reason: None
        })
        .is_err());
}

#[test]
fn sample_zip_roundtrip_restores_complete_records_and_images() {
    let (_directory, mut store) = store();
    let bytes =
        include_bytes!("../../../docs/examples/patch-maintenance/patch-maintenance.runbook.zip");
    let preview = store.preview_import("sample.runbook.zip", bytes).unwrap();
    assert!(!preview.duplicate);
    let workspace = store.commit_import(&preview.token, false).unwrap();
    assert_eq!(workspace.instances[0].entries.len(), 9);
    let exported = store
        .export_data("instance", &workspace.instances[0].id)
        .unwrap();
    let parsed = archive::parse(&exported.name, &exported.bytes).unwrap();
    if let archive::Imported::Instance(i) = parsed.value {
        assert_eq!(i, workspace.instances[0]);
    } else {
        panic!("expected instance")
    }
    assert_eq!(parsed.images.len(), 1);
}

fn zip(files: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(
            name,
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
#[test]
fn archives_reject_traversal_duplicates_missing_extra_images_and_invalid_records() {
    let template =
        include_bytes!("../../../docs/examples/patch-maintenance/template.runbook.json").to_vec();
    for path in [
        "../escape.png",
        "images/../../escape.png",
        "images\\escape.png",
        "/images/a.png",
        "C:/a.png",
        "images/CON.png",
    ] {
        assert!(archive::parse(
            "bad.zip",
            &zip(vec![
                ("runbook.json", template.clone()),
                (path, IMAGE.to_vec())
            ])
        )
        .is_err());
    }
    assert!(archive::parse(
        "bad.zip",
        &zip(vec![
            ("runbook.json", template.clone()),
            ("runbook.json", template.clone())
        ])
    )
    .is_err());
    assert!(archive::parse(
        "bad.zip",
        &zip(vec![
            ("runbook.json", template.clone()),
            ("images/unused.png", IMAGE.to_vec())
        ])
    )
    .is_err());
    let instance = include_bytes!("../../../docs/examples/patch-maintenance/runbook.json").to_vec();
    assert!(archive::parse("missing.json", &instance).is_err());
    assert!(archive::parse(
        "bad.zip",
        &zip(vec![
            ("runbook.json", instance.clone()),
            ("images/package-check-demo.png", b"fake".to_vec())
        ])
    )
    .is_err());
    let mut i: Instance = serde_json::from_slice(&instance).unwrap();
    if let Entry::Result { reason, .. } = &mut i.entries[1] {
        *reason = None;
    }
    assert!(validate::instance(&i).is_err());
    let mut i: Instance = serde_json::from_slice(&instance).unwrap();
    i.entries.swap(0, 1);
    assert!(validate::instance(&i).is_err());
    let bomb = zip(vec![("runbook.json", vec![b' '; 2 * 1024 * 1024])]);
    assert!(archive::parse("bomb.zip", &bomb)
        .err()
        .unwrap()
        .contains("压缩比"));
}

#[test]
fn identifiers_and_image_signatures_have_windows_safe_boundaries() {
    for id in [
        "..", "a.", "CON", "aux", "COM1", "a/b", "a\\b", "a:b", "a b",
    ] {
        assert!(validate::identifier(id).is_err(), "{id}");
    }
    assert!(validate::identifier("s1-target_2").is_ok());
    assert!(validate::image(IMAGE, "image/png").is_ok());
    assert!(validate::image(IMAGE, "image/jpeg").is_err());
    assert!(validate::image(b"text", "text/plain").is_err());
}

#[test]
fn rejected_mutation_leaves_database_and_workspace_unchanged() {
    let (_directory, mut store) = store();
    create(&mut store, "work");
    fill_start(&mut store, "work");
    let before = store.workspace().unwrap();
    assert!(store
        .apply(Action::RecordResult {
            id: "work".into(),
            outcome: Outcome::Failed,
            reason: None
        })
        .is_err());
    assert_eq!(store.workspace().unwrap(), before);
}

#[test]
fn windows_case_alias_cannot_replace_another_instances_images() {
    let (_directory, mut store) = store();
    create(&mut store, "work");
    assert!(store
        .apply(Action::CreateInstance {
            id: "WORK".into(),
            template_id: Some("demo-patch-template".into()),
            from_instance_id: None,
            name: "大小写重复".into()
        })
        .is_err());
    let mut instance = store.workspace().unwrap().instances[0].clone();
    instance.id = "WORK".into();
    let bytes = serde_json::to_vec(&instance).unwrap();
    let preview = store.preview_import("copy.runbook.json", &bytes).unwrap();
    assert!(preview.duplicate);
    assert!(store.commit_import(&preview.token, false).is_err());
    assert_eq!(store.workspace().unwrap().instances.len(), 1);
}
