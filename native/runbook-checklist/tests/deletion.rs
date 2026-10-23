use runbook_checklist::*;
use std::path::{Path, PathBuf};

const IMAGE: &[u8] =
    include_bytes!("../../../docs/examples/patch-maintenance/images/package-check-demo.png");
const TEMPLATE: &str = "demo-patch-template";

fn create(store: &mut Store, id: &str) -> Workspace {
    store
        .apply(Action::CreateInstance {
            id: id.into(),
            template_id: Some(TEMPLATE.into()),
            from_instance_id: None,
            name: format!("工作 {id}"),
        })
        .unwrap()
}

fn start(store: &mut Store, id: &str) {
    let mut values = store
        .workspace()
        .unwrap()
        .instances
        .iter()
        .find(|i| i.id == id)
        .unwrap()
        .parameter_values
        .clone();
    values.insert("packagePath".into(), "C:\\maintenance.zip".into());
    store
        .apply(Action::ApplyParameters {
            id: id.into(),
            values,
        })
        .unwrap();
    store
        .apply(Action::StartInstance { id: id.into() })
        .unwrap();
}

fn image_paths(instance: &Instance) -> Vec<String> {
    instance
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Image { path, .. } => Some(path.clone()),
            _ => None,
        })
        .collect()
}

fn image_file(directory: &Path, id: &str, path: &str) -> PathBuf {
    directory.join("checklist-images").join(id).join(path)
}

#[test]
fn deleting_template_preserves_independent_instances_blocks_and_source_ids_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    // Artifact kinds have separate identities even when their IDs match.
    let mut before = create(&mut store, TEMPLATE);
    let block_document = before.blocks[0].document.clone();
    before = store
        .apply(Action::CreateBlock {
            id: TEMPLATE.into(),
            name: "同身份但独立的步骤块".into(),
            document: block_document,
        })
        .unwrap();
    let action: Action = serde_json::from_value(serde_json::json!({
        "type": "delete_template", "id": TEMPLATE
    }))
    .unwrap();
    let actual = store.apply(action).unwrap();
    before.templates.retain(|t| t.id != TEMPLATE);
    assert_eq!(actual, before);
    assert_eq!(
        actual.instances[0].source_template_id.as_deref(),
        Some(TEMPLATE)
    );
    assert!(store.export_data("instance", TEMPLATE).is_ok());
    assert!(store
        .apply(Action::CreateInstance {
            id: "new-work".into(),
            template_id: Some(TEMPLATE.into()),
            from_instance_id: None,
            name: "失效来源".into(),
        })
        .is_err());
    assert_eq!(store.workspace().unwrap(), actual);
    drop(store);
    let reopened = Store::open(directory.path()).unwrap();
    assert_eq!(reopened.workspace().unwrap(), actual);
    assert!(
        actual.templates.is_empty(),
        "deletion must not reseed on restart"
    );
}

#[test]
fn deleting_instance_removes_all_states_and_materials_without_changing_other_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    create(&mut store, "untouched");
    store
        .attach_image("untouched", "s1-target", "keep.png", "image/png", IMAGE)
        .unwrap();
    let cases = [
        ("draft", Status::Draft, false),
        ("running", Status::InProgress, false),
        ("completed", Status::Completed, false),
        ("terminated", Status::Terminated, false),
        ("archived-completed", Status::Completed, true),
        ("archived-terminated", Status::Terminated, true),
    ];
    for (id, status, archived) in cases {
        create(&mut store, id);
        store
            .apply(Action::AddComment {
                id: id.into(),
                step_id: "s1-target".into(),
                entry_id: "comment".into(),
                text: "本实例的操作记录".into(),
            })
            .unwrap();
        for _ in 0..2 {
            store
                .attach_image(id, "s1-target", "test.png", "image/png", IMAGE)
                .unwrap();
        }
        if status != Status::Draft {
            start(&mut store, id);
            store
                .apply(Action::RecordResult {
                    id: id.into(),
                    outcome: Outcome::Failed,
                    reason: Some("保留失败记录".into()),
                })
                .unwrap();
        }
        if status == Status::Completed {
            let count = store
                .workspace()
                .unwrap()
                .instances
                .iter()
                .find(|i| i.id == id)
                .unwrap()
                .document
                .steps
                .len();
            for _ in 0..count {
                store
                    .apply(Action::RecordResult {
                        id: id.into(),
                        outcome: Outcome::Completed,
                        reason: None,
                    })
                    .unwrap();
            }
        } else if status == Status::Terminated {
            store
                .apply(Action::TerminateInstance {
                    id: id.into(),
                    reason: "取消本次维护".into(),
                })
                .unwrap();
        }
        if archived {
            store
                .apply(Action::ArchiveInstance {
                    id: id.into(),
                    archived: true,
                })
                .unwrap();
        }
        let mut before = store.workspace().unwrap();
        let target = before.instances.iter().find(|i| i.id == id).unwrap();
        assert_eq!(target.status, status);
        assert_eq!(target.archived_at.is_some(), archived);
        let paths = image_paths(target);
        assert_eq!(paths.len(), 2);
        let actual = store
            .apply(
                serde_json::from_value(serde_json::json!({
                    "type": "delete_instance", "id": id
                }))
                .unwrap(),
            )
            .unwrap();
        before.instances.retain(|i| i.id != id);
        assert_eq!(actual, before);
        assert!(store.export_data("instance", id).is_err());
        for path in paths {
            assert!(!image_file(directory.path(), id, &path).exists());
            assert!(store.read_image(id, &path).is_err());
        }
        let kept = &actual.instances[0];
        assert_eq!(kept.id, "untouched");
        for path in image_paths(kept) {
            assert!(store.read_image("untouched", &path).is_ok());
        }
        drop(store);
        store = Store::open(directory.path()).unwrap();
        assert_eq!(store.workspace().unwrap(), actual);
    }
}

#[test]
fn deleting_source_keeps_archive_copy_images_with_the_same_registered_paths() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    create(&mut store, "source");
    store
        .attach_image("source", "s1-target", "test.png", "image/png", IMAGE)
        .unwrap();
    store
        .apply(Action::CreateInstance {
            id: "retry".into(),
            template_id: None,
            from_instance_id: Some("source".into()),
            name: "独立工作副本".into(),
        })
        .unwrap();
    let exported = store.export_data("instance", "source").unwrap();
    let preview = store
        .preview_import(&exported.name, &exported.bytes)
        .unwrap();
    let mut expected = store.commit_import(&preview.token, true).unwrap();
    let copy = expected.instances.last().unwrap().clone();
    let path = image_paths(&copy).remove(0);
    assert_eq!(image_paths(&expected.instances[0]), vec![path.clone()]);
    let copy_file = image_file(directory.path(), &copy.id, &path);
    let copied_bytes = std::fs::read(&copy_file).unwrap();
    let actual = store
        .apply(Action::DeleteInstance {
            id: "source".into(),
        })
        .unwrap();
    expected.instances.retain(|i| i.id != "source");
    assert_eq!(actual, expected);
    assert_eq!(
        actual.instances[0].source_instance_id.as_deref(),
        Some("source")
    );
    assert_eq!(std::fs::read(copy_file).unwrap(), copied_bytes);
    assert!(store.read_image(&copy.id, &path).is_ok());
    assert!(!image_file(directory.path(), "source", &path).exists());
    drop(store);
    let reopened = Store::open(directory.path()).unwrap();
    assert_eq!(reopened.workspace().unwrap(), expected);
    assert!(reopened.read_image(&copy.id, &path).is_ok());
}

#[test]
fn missing_targets_and_non_action_confirmation_payloads_do_not_write() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    create(&mut store, "work");
    let before = store.workspace().unwrap();
    for (action, message) in [
        (
            Action::DeleteTemplate {
                id: "missing".into(),
            },
            "找不到模板",
        ),
        (
            Action::DeleteInstance {
                id: "missing".into(),
            },
            "找不到实例",
        ),
        (Action::DeleteInstance { id: "WORK".into() }, "找不到实例"),
        (
            Action::DeleteInstance {
                id: "../work".into(),
            },
            "找不到实例",
        ),
    ] {
        assert_eq!(store.apply(action).unwrap_err(), message);
        assert_eq!(store.workspace().unwrap(), before);
    }
    // A confirmation dialog cancellation dispatches no Action. The native
    // boundary does not accept an accidental "confirmed: false" deletion.
    for kind in ["delete_template", "delete_instance"] {
        assert!(serde_json::from_value::<Action>(serde_json::json!({
            "type": kind, "id": "work", "confirmed": false
        }))
        .is_err());
        assert!(serde_json::from_value::<Action>(serde_json::json!({ "type": kind })).is_err());
    }
    assert_eq!(store.workspace().unwrap(), before);
    drop(store);
    assert_eq!(
        Store::open(directory.path()).unwrap().workspace().unwrap(),
        before
    );
}

#[test]
fn committed_deletion_does_not_recursively_remove_unregistered_files_or_report_cleanup_failure() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let created = create(&mut store, "work");
    let attached = store
        .attach_image("work", "s1-target", "test.png", "image/png", IMAGE)
        .unwrap();
    let path = image_paths(&attached.instances[0]).remove(0);
    let file = image_file(directory.path(), "work", &path);
    std::fs::remove_file(&file).unwrap();
    // A directory in place of a registered image cannot be unlinked as a file.
    std::fs::create_dir(&file).unwrap();
    let nested = file.join("keep.txt");
    std::fs::write(&nested, b"must remain").unwrap();
    let unregistered = file.parent().unwrap().join("not-registered.png");
    std::fs::write(&unregistered, IMAGE).unwrap();
    let actual = store
        .apply(Action::DeleteInstance { id: "work".into() })
        .unwrap();
    assert!(actual.instances.is_empty());
    assert_eq!(actual.templates, created.templates);
    assert_eq!(actual.blocks, created.blocks);
    assert_eq!(std::fs::read(nested).unwrap(), b"must remain");
    assert_eq!(std::fs::read(unregistered).unwrap(), IMAGE);
    drop(store);
    assert_eq!(
        Store::open(directory.path()).unwrap().workspace().unwrap(),
        actual
    );
}

#[cfg(windows)]
fn link_directory(source: &Path, link: &Path) {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(source)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "failed to create isolated junction: {output:?}"
    );
}

#[cfg(unix)]
fn link_directory(source: &Path, link: &Path) {
    std::os::unix::fs::symlink(source, link).unwrap();
}

#[cfg(any(windows, unix))]
#[test]
fn deletion_does_not_follow_an_instance_directory_junction_or_symlink() {
    let directory = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    create(&mut store, "work");
    let attached = store
        .attach_image("work", "s1-target", "test.png", "image/png", IMAGE)
        .unwrap();
    let path = image_paths(&attached.instances[0]).remove(0);
    let instance_directory = directory.path().join("checklist-images").join("work");
    let foreign_instance = foreign.path().join("keep-instance");
    std::fs::rename(&instance_directory, &foreign_instance).unwrap();
    link_directory(&foreign_instance, &instance_directory);
    let actual = store
        .apply(Action::DeleteInstance { id: "work".into() })
        .unwrap();
    assert!(actual.instances.is_empty());
    assert_eq!(std::fs::read(foreign_instance.join(path)).unwrap(), IMAGE);
    // Remove only the test link, never recursively visit its target.
    #[cfg(windows)]
    std::fs::remove_dir(&instance_directory).unwrap();
    #[cfg(unix)]
    std::fs::remove_file(&instance_directory).unwrap();
}
