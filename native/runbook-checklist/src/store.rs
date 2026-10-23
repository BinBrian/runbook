use crate::{
    archive::{self, ExportData, ImportData, ImportPreview, Imported},
    model::*,
    validate::{self, ensure},
    work,
};
use base64::Engine;
use rusqlite::{params, Connection};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
};

pub struct Store {
    connection: Connection,
    directory: PathBuf,
    pending: BTreeMap<String, ImportData>,
}
impl Store {
    pub fn open(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let connection =
            Connection::open(directory.join("checklist.sqlite3")).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checklist_workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);").map_err(|e|e.to_string())?;
        let mut store = Self {
            connection,
            directory: directory.into(),
            pending: BTreeMap::new(),
        };
        let count: i64 = store
            .connection
            .query_row("SELECT count(*) FROM checklist_workspace", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count == 0 {
            let mut template: Template = serde_json::from_str(include_str!(
                "../../../docs/examples/patch-maintenance/template.runbook.json"
            ))
            .map_err(|e| e.to_string())?;
            template.format_version = 2;
            let blocks = [
                include_str!("../../../docs/examples/blocks/restart-services.runbook.json"),
                include_str!("../../../docs/examples/blocks/transfer-player.runbook.json"),
            ]
            .iter()
            .map(|source| serde_json::from_str(source).map_err(|e| e.to_string()))
            .collect::<Result<Vec<Template>, String>>()?;
            store.save(&Workspace {
                templates: vec![template],
                instances: Vec::new(),
                blocks,
            })?;
        }
        store.workspace()?;
        Ok(store)
    }
    pub fn workspace(&self) -> Result<Workspace, String> {
        let body: String = self
            .connection
            .query_row("SELECT body FROM checklist_workspace WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let workspace: Workspace =
            serde_json::from_str(&body).map_err(|e| format!("清单数据库内容无效：{e}"))?;
        validate::workspace(&workspace)?;
        Ok(workspace)
    }
    /// Only the work-facing entry upgrades former definitions. Historical readers
    /// remain read-only; the original row and identity mapping commit together.
    pub fn work_workspace(&mut self) -> Result<work::WorkLoad, String> {
        let mut workspace = self.workspace()?;
        if !workspace.templates.is_empty() {
            let original: String = self
                .connection
                .query_row("SELECT body FROM checklist_workspace WHERE id=1", [], |r| {
                    r.get(0)
                })
                .map_err(|e| e.to_string())?;
            let mut mapping = BTreeMap::new();
            for template in std::mem::take(&mut workspace.templates) {
                let mut id = template.id.clone();
                while workspace
                    .instances
                    .iter()
                    .any(|i| i.id.eq_ignore_ascii_case(&id))
                {
                    id = new_id();
                }
                workspace
                    .instances
                    .push(work::from_template(&template, id.clone())?);
                mapping.insert(template.id, id);
            }
            validate::workspace(&workspace)?;
            let body = serde_json::to_string(&workspace).map_err(|e| e.to_string())?;
            let mapping = serde_json::to_string(&mapping).map_err(|e| e.to_string())?;
            let tx = self.connection.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS checklist_work_migrations (id TEXT PRIMARY KEY, original_body TEXT NOT NULL, mapping TEXT NOT NULL)").map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO checklist_work_migrations(id,original_body,mapping) VALUES(?1,?2,?3)",
                params![new_id(), original, mapping],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE checklist_workspace SET body=?1 WHERE id=1",
                params![body],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        let mut converted_templates = BTreeMap::new();
        let exists: i64 = self.connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='checklist_work_migrations'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if exists != 0 {
            let mut statement = self
                .connection
                .prepare("SELECT mapping FROM checklist_work_migrations ORDER BY rowid")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let mapping: BTreeMap<String, String> =
                    serde_json::from_str(&row.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                converted_templates.extend(mapping);
            }
        }
        Ok(work::WorkLoad {
            workspace,
            converted_templates,
        })
    }
    fn save(&mut self, workspace: &Workspace) -> Result<(), String> {
        validate::workspace(workspace)?;
        let body = serde_json::to_string(workspace).map_err(|e| e.to_string())?;
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        transaction.execute("INSERT INTO checklist_workspace(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![body]).map_err(|e|e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
    }
    pub fn apply(&mut self, action: Action) -> Result<Workspace, String> {
        let mut workspace = self.workspace()?;
        let at = now();
        let mut removed_images = Vec::new();
        match action {
            Action::CaptureFavorite {
                id,
                name,
                source_id,
                step_id,
                group_id,
                replace_id,
            } => {
                let source = find(&workspace, &source_id)?;
                let mut snapshot = crate::favorite::capture(
                    source,
                    replace_id.clone().unwrap_or(id),
                    name,
                    step_id.as_deref(),
                    group_id.as_deref(),
                )?;
                if let Some(replace) = replace_id {
                    let previous = workspace
                        .blocks
                        .iter_mut()
                        .find(|b| b.id == replace)
                        .ok_or("待更新收藏已不存在")?;
                    snapshot.created_at = previous.created_at.clone();
                    *previous = snapshot;
                } else {
                    ensure(
                        !workspace.blocks.iter().any(|b| b.id == snapshot.id),
                        "收藏身份已存在",
                    )?;
                    workspace.blocks.push(snapshot);
                }
            }
            Action::RenameFavorite { id, name } => {
                let item = workspace
                    .blocks
                    .iter_mut()
                    .find(|b| b.id == id)
                    .ok_or("收藏已不存在")?;
                item.name = name;
                item.updated_at = at.clone();
            }
            Action::CreateWork { id, name, document } => {
                ensure(
                    !workspace
                        .instances
                        .iter()
                        .any(|i| i.id.eq_ignore_ascii_case(&id)),
                    "工作身份已存在",
                )?;
                let values = work::defaults(&document);
                workspace
                    .instances
                    .push(work::fresh(id, name, document, values, None));
            }
            Action::RepeatWork {
                id,
                name,
                source_id,
                carry_values,
            } => {
                ensure(
                    !workspace
                        .instances
                        .iter()
                        .any(|i| i.id.eq_ignore_ascii_case(&id)),
                    "工作身份已存在",
                )?;
                let source = find(&workspace, &source_id)?;
                let values = if carry_values {
                    source.parameter_values.clone()
                } else {
                    work::defaults(&source.document)
                };
                let next = work::fresh(
                    id,
                    name,
                    source.document.clone(),
                    values,
                    Some(source.id.clone()),
                );
                workspace.instances.push(next);
            }
            Action::CreateBlock { id, name, document } => {
                ensure(
                    !workspace.blocks.iter().any(|b| b.id == id),
                    "步骤块身份已存在",
                )?;
                workspace.blocks.push(Template {
                    favorite: None,
                    format_version: 2,
                    kind: "block".into(),
                    id,
                    name,
                    document,
                    created_at: at.clone(),
                    updated_at: at.clone(),
                });
            }
            Action::SaveBlock { id, name, document } => {
                let block = workspace
                    .blocks
                    .iter_mut()
                    .find(|b| b.id == id)
                    .ok_or("找不到步骤块")?;
                block.name = name;
                block.document = document;
                block.format_version = 2;
                block.updated_at = at.clone();
            }
            Action::DeleteBlock { id } => {
                let index = workspace
                    .blocks
                    .iter()
                    .position(|b| b.id == id)
                    .ok_or("找不到步骤块")?;
                workspace.blocks.remove(index);
            }
            Action::CreateTemplate { id, name, document } => {
                ensure(
                    !workspace.templates.iter().any(|t| t.id == id),
                    "模板身份已存在",
                )?;
                workspace.templates.push(Template {
                    favorite: None,
                    format_version: 2,
                    kind: "template".into(),
                    id,
                    name,
                    document,
                    created_at: at.clone(),
                    updated_at: at.clone(),
                });
            }
            Action::SaveTemplate { id, name, document } => {
                let t = workspace
                    .templates
                    .iter_mut()
                    .find(|t| t.id == id)
                    .ok_or("找不到模板")?;
                t.name = name;
                t.document = document;
                t.format_version = 2;
                t.updated_at = at.clone();
            }
            Action::DeleteTemplate { id } => {
                let index = workspace
                    .templates
                    .iter()
                    .position(|t| t.id == id)
                    .ok_or("找不到模板")?;
                workspace.templates.remove(index);
            }
            Action::CreateInstance {
                id,
                template_id,
                from_instance_id,
                name,
            } => {
                ensure(
                    !workspace
                        .instances
                        .iter()
                        .any(|i| i.id.eq_ignore_ascii_case(&id)),
                    "实例身份已存在",
                )?;
                ensure(
                    template_id.is_some() ^ from_instance_id.is_some(),
                    "请选择模板或来源实例",
                )?;
                let (document, values, source_template_id) = if let Some(source) = &from_instance_id
                {
                    let i = find(&workspace, source)?;
                    (
                        i.document.clone(),
                        i.parameter_values.clone(),
                        i.source_template_id.clone(),
                    )
                } else {
                    let t = workspace
                        .templates
                        .iter()
                        .find(|t| Some(&t.id) == template_id.as_ref())
                        .ok_or("找不到来源模板")?;
                    (
                        t.document.clone(),
                        t.document
                            .parameters
                            .iter()
                            .map(|p| (p.id.clone(), p.default_value.clone()))
                            .collect(),
                        Some(t.id.clone()),
                    )
                };
                workspace.instances.push(Instance {
                    format_version: 2,
                    kind: "instance".into(),
                    id,
                    name,
                    source_template_id,
                    source_instance_id: from_instance_id,
                    created_at: at.clone(),
                    started_at: None,
                    updated_at: at.clone(),
                    status: Status::Draft,
                    current_step_id: None,
                    finished_at: None,
                    termination_reason: None,
                    archived_at: None,
                    document,
                    parameter_values: values,
                    entries: Vec::new(),
                });
            }
            Action::DeleteInstance { id } => {
                let index = workspace
                    .instances
                    .iter()
                    .position(|i| i.id == id)
                    .ok_or("找不到实例")?;
                let instance = workspace.instances.remove(index);
                for entry in instance.entries {
                    if let Entry::Image { path, .. } = entry {
                        removed_images.push((instance.id.clone(), path));
                    }
                }
            }
            Action::SaveInstance { id, name, document } => {
                validate::document(&document)?;
                let i = find_mut(&mut workspace, &id)?;
                match i.status {
                    Status::Completed | Status::Terminated => {
                        ensure(i.document == document, "已结束实例的流程不可更改")?
                    }
                    Status::InProgress => {
                        let cursor = current_index(i)?;
                        ensure(
                            document.steps.len() > cursor
                                && document.steps[..cursor] == i.document.steps[..cursor]
                                && document.steps[cursor].id == i.document.steps[cursor].id
                                && document.steps[cursor].group_id
                                    == i.document.steps[cursor].group_id,
                            "已推进步骤冻结，当前步骤身份和位置不可改变",
                        )?;
                        let mut frozen = BTreeSet::new();
                        let progressed_groups: BTreeSet<_> = i.document.steps[..cursor]
                            .iter()
                            .filter_map(|s| s.group_id.as_deref())
                            .collect();
                        for group_id in &progressed_groups {
                            ensure(
                                i.document.groups.iter().find(|g| g.id == *group_id)
                                    == document.groups.iter().find(|g| g.id == *group_id),
                                "已推进步骤所属组的定义不可更改",
                            )?;
                        }
                        frozen.extend(validate::frozen_local_parameters(i));
                        for s in &i.document.steps[..cursor] {
                            for p in std::iter::once(&s.title)
                                .chain(std::iter::once(&s.description))
                                .chain(s.commands.iter().map(|c| &c.text))
                                .flatten()
                            {
                                if let TextPart::Parameter(p) = p {
                                    frozen.insert(p.parameter_id.as_str());
                                }
                            }
                        }
                        for id in frozen {
                            ensure(
                                i.document.parameters.iter().find(|p| p.id == id)
                                    == document.parameters.iter().find(|p| p.id == id),
                                "已推进步骤引用的参数定义不可更改",
                            )?;
                        }
                    }
                    Status::Draft => {}
                }
                ensure(
                    i.entries
                        .iter()
                        .all(|e| document.steps.iter().any(|s| s.id == e.step_id())),
                    "请先移除该步骤的评论和图片，再删除步骤",
                )?;
                let values = if matches!(i.status, Status::Completed | Status::Terminated) {
                    i.parameter_values.clone()
                } else {
                    document
                        .parameters
                        .iter()
                        .map(|p| {
                            (
                                p.id.clone(),
                                i.parameter_values
                                    .get(&p.id)
                                    .cloned()
                                    .unwrap_or_else(|| p.default_value.clone()),
                            )
                        })
                        .collect()
                };
                i.name = name;
                i.document = document;
                i.parameter_values = values;
                i.updated_at = at.clone();
            }
            Action::ApplyParameters { id, values } => {
                let i = find_mut(&mut workspace, &id)?;
                ensure(
                    matches!(i.status, Status::Draft | Status::InProgress),
                    "已结束实例的参数不可更改",
                )?;
                validate::values(&i.document, &values, i.status == Status::InProgress)?;
                if i.status == Status::InProgress {
                    for parameter in validate::frozen_local_parameters(i) {
                        ensure(
                            i.parameter_values.get(parameter) == values.get(parameter),
                            "已推进步骤或已完成步骤组的局部参数值不可更改",
                        )?;
                    }
                }
                i.parameter_values = values;
                i.updated_at = at.clone();
            }
            Action::StartInstance { id } => {
                let i = find_mut(&mut workspace, &id)?;
                ensure(
                    i.status == Status::Draft,
                    "仅草稿可以开始；结束或终止后请复制为新实例",
                )?;
                validate::values(&i.document, &i.parameter_values, true)?;
                i.status = Status::InProgress;
                i.current_step_id = Some(i.document.steps[0].id.clone());
                i.started_at = Some(at.clone());
                i.updated_at = at.clone();
            }
            Action::RecordResult {
                id,
                outcome,
                reason,
            } => {
                let i = find_mut(&mut workspace, &id)?;
                ensure(i.status == Status::InProgress, "仅进行中的实例可以记录结果")?;
                validate::values(&i.document, &i.parameter_values, true)?;
                let cursor = current_index(i)?;
                let step = &i.document.steps[cursor];
                let reason = reason
                    .map(|r| r.trim().to_string())
                    .filter(|r| !r.is_empty());
                if outcome != Outcome::Completed {
                    validate::name(reason.as_deref().unwrap_or(""))?;
                }
                i.entries.push(Entry::Result {
                    id: new_id(),
                    step_id: step.id.clone(),
                    at: at.clone(),
                    outcome: outcome.clone(),
                    reason,
                    snapshot: snapshot(step, &i.parameter_values),
                });
                if outcome != Outcome::Failed {
                    i.current_step_id = i.document.steps.get(cursor + 1).map(|s| s.id.clone());
                    if i.current_step_id.is_none() {
                        i.status = Status::Completed;
                        i.finished_at = Some(at.clone());
                    }
                }
                i.updated_at = at.clone();
            }
            Action::TerminateInstance { id, reason } => {
                validate::name(&reason)?;
                let i = find_mut(&mut workspace, &id)?;
                ensure(i.status == Status::InProgress, "仅进行中的实例可以终止")?;
                i.status = Status::Terminated;
                i.termination_reason = Some(reason.trim().into());
                i.finished_at = Some(at.clone());
                i.current_step_id = None;
                i.updated_at = at.clone();
            }
            Action::ArchiveInstance { id, archived } => {
                let i = find_mut(&mut workspace, &id)?;
                ensure(
                    matches!(i.status, Status::Completed | Status::Terminated),
                    "请先完成或终止实例再归档",
                )?;
                i.archived_at = if archived { Some(at.clone()) } else { None };
                i.updated_at = at.clone();
            }
            Action::SaveAsTemplate {
                id,
                template_id,
                name,
            } => {
                ensure(
                    !workspace.templates.iter().any(|t| t.id == template_id),
                    "新模板身份已存在，不能覆盖原模板",
                )?;
                let i = find(&workspace, &id)?;
                workspace.templates.push(Template {
                    favorite: None,
                    format_version: 2,
                    kind: "template".into(),
                    id: template_id,
                    name,
                    document: i.document.clone(),
                    created_at: at.clone(),
                    updated_at: at.clone(),
                });
            }
            Action::AddComment {
                id,
                step_id,
                entry_id,
                text,
            } => {
                let i = find_mut(&mut workspace, &id)?;
                ensure(
                    i.document.steps.iter().any(|s| s.id == step_id),
                    "找不到步骤",
                )?;
                ensure(
                    !i.entries.iter().any(|e| e.id() == entry_id),
                    "记录身份已存在",
                )?;
                i.entries.push(Entry::Comment {
                    id: entry_id,
                    step_id,
                    at: at.clone(),
                    text,
                    edited_at: None,
                });
                i.updated_at = at.clone();
            }
            Action::EditComment { id, entry_id, text } => {
                let i = find_mut(&mut workspace, &id)?;
                if let Some(Entry::Comment {
                    text: saved,
                    edited_at,
                    ..
                }) = i.entries.iter_mut().find(|e| e.id() == entry_id)
                {
                    *saved = text;
                    *edited_at = Some(at.clone());
                } else {
                    return Err("仅评论可以编辑".into());
                }
                i.updated_at = at.clone();
            }
            Action::DeleteEntry { id, entry_id } => {
                let i = find_mut(&mut workspace, &id)?;
                let index = i
                    .entries
                    .iter()
                    .position(|e| e.id() == entry_id)
                    .ok_or("找不到记录")?;
                ensure(
                    !matches!(i.entries[index], Entry::Result { .. }),
                    "执行结果不能删除或改写",
                )?;
                if let Entry::Image { path, .. } = &i.entries[index] {
                    removed_images.push((i.id.clone(), path.clone()));
                }
                i.entries.remove(index);
                i.updated_at = at.clone();
            }
        }
        self.save(&workspace)?;
        // A failed DB commit leaves the original referenced image intact.
        // File cleanup is best effort after commit: an unlink failure cannot
        // turn a committed deletion into a reported database failure.
        for (id, path) in removed_images {
            let _ = self.remove_registered_image(&id, &path);
        }
        Ok(workspace)
    }
    pub fn preview_import(&mut self, name: &str, bytes: &[u8]) -> Result<ImportPreview, String> {
        let data = archive::parse(name, bytes)?;
        self.preview_data(data)
    }
    pub fn preview_work_import(
        &mut self,
        name: &str,
        bytes: &[u8],
    ) -> Result<ImportPreview, String> {
        let mut data = archive::parse(name, bytes)?;
        if let Imported::Template(template) = &data.value {
            data.value = Imported::Instance(work::from_template(template, template.id.clone())?);
        }
        self.preview_data(data)
    }
    fn preview_data(&mut self, data: ImportData) -> Result<ImportPreview, String> {
        let workspace = self.workspace()?;
        let (kind, name, id, duplicate) = match &data.value {
            Imported::Block(b) => (
                "block",
                b.name.clone(),
                b.id.clone(),
                workspace.blocks.iter().any(|local| local.id == b.id),
            ),
            Imported::Template(t) => (
                "template",
                t.name.clone(),
                t.id.clone(),
                workspace.templates.iter().any(|local| local.id == t.id),
            ),
            Imported::Instance(i) => (
                "instance",
                i.name.clone(),
                i.id.clone(),
                workspace
                    .instances
                    .iter()
                    .any(|local| local.id.eq_ignore_ascii_case(&i.id)),
            ),
        };
        // At most two pending previews so cancelled large files cannot accumulate.
        if self.pending.len() >= 2 {
            self.pending.clear();
        }
        let token = new_id();
        let result = ImportPreview {
            token: token.clone(),
            kind: kind.into(),
            name,
            id,
            duplicate,
        };
        self.pending.insert(token, data);
        Ok(result)
    }
    pub fn commit_import(&mut self, token: &str, as_copy: bool) -> Result<Workspace, String> {
        let mut workspace = self.workspace()?;
        let data = self
            .pending
            .get(token)
            .ok_or("待导入内容已失效，请重新选择文件")?;
        let mut target = match &data.value {
            Imported::Template(t) => Imported::Template(t.clone()),
            Imported::Instance(i) => Imported::Instance(i.clone()),
            Imported::Block(b) => Imported::Block(b.clone()),
        };
        let mut installed = Vec::new();
        match &mut target {
            Imported::Block(b) => {
                ensure(
                    as_copy || !workspace.blocks.iter().any(|local| local.id == b.id),
                    "步骤块重复，请明确选择导入为独立副本",
                )?;
                if as_copy {
                    b.id = new_id();
                    b.name = format!("{}（导入副本）", b.name);
                }
                workspace.blocks.push(b.clone());
            }
            Imported::Template(t) => {
                t.format_version = 2;
                ensure(
                    as_copy || !workspace.templates.iter().any(|local| local.id == t.id),
                    "模板重复，请明确选择导入为独立副本",
                )?;
                if as_copy {
                    t.id = new_id();
                    t.name = format!("{}（导入副本）", t.name);
                }
                workspace.templates.push(t.clone());
            }
            Imported::Instance(i) => {
                i.format_version = 2;
                ensure(
                    as_copy
                        || !workspace
                            .instances
                            .iter()
                            .any(|local| local.id.eq_ignore_ascii_case(&i.id)),
                    "实例重复，请明确选择导入为独立副本",
                )?;
                if as_copy {
                    i.id = new_id();
                    i.name = format!("{}（导入副本）", i.name);
                }
                for (path, bytes) in &data.images {
                    let destination = self.image_file(&i.id, path)?;
                    if let Err(error) = atomic_write(&destination, bytes) {
                        for saved in installed {
                            let _ = std::fs::remove_file(saved);
                        }
                        return Err(error);
                    }
                    installed.push(destination);
                }
                workspace.instances.push(i.clone());
            }
        }
        if let Err(error) = self.save(&workspace) {
            for saved in installed {
                let _ = std::fs::remove_file(saved);
            }
            return Err(error);
        }
        self.pending.remove(token);
        Ok(workspace)
    }
    pub fn export_data(&self, kind: &str, id: &str) -> Result<ExportData, String> {
        let workspace = self.workspace()?;
        match kind {
            "block" => archive::template(
                workspace
                    .blocks
                    .iter()
                    .find(|b| b.id == id)
                    .ok_or("找不到步骤块")?,
            ),
            "template" => archive::template(
                workspace
                    .templates
                    .iter()
                    .find(|t| t.id == id)
                    .ok_or("找不到模板")?,
            ),
            "instance" => {
                let i = find(&workspace, id)?;
                let mut images = BTreeMap::new();
                for entry in &i.entries {
                    if let Entry::Image { path, .. } = entry {
                        images.insert(path.clone(), self.image_bytes(i, path)?);
                    }
                }
                archive::instance(i, &images)
            }
            _ => Err("导出类型无效".into()),
        }
    }
    fn image_file(&self, id: &str, path: &str) -> Result<PathBuf, String> {
        validate::identifier(id)?;
        validate::image_path(path)?;
        Ok(self.directory.join("checklist-images").join(id).join(path))
    }
    fn remove_registered_image(&self, id: &str, path: &str) -> Result<(), String> {
        let file = self.image_file(id, path)?;
        let relative = file
            .strip_prefix(&self.directory)
            .map_err(|_| "图片不在数据目录内")?;
        let root = self.directory.canonicalize().map_err(|e| e.to_string())?;
        let mut checked = root.clone();
        // Reject links and Windows junctions on every owned path component.
        // Never follow a redirected instance/images directory during cleanup.
        for component in relative.components() {
            checked.push(component);
            let metadata = std::fs::symlink_metadata(&checked).map_err(|e| e.to_string())?;
            ensure(
                !is_link_or_reparse(&metadata),
                "图片路径不能经过链接或重解析点",
            )?;
        }
        let metadata = std::fs::symlink_metadata(&checked).map_err(|e| e.to_string())?;
        ensure(metadata.is_file(), "仅允许清理登记的图片文件")?;
        let canonical = checked.canonicalize().map_err(|e| e.to_string())?;
        ensure(
            canonical.starts_with(root.join("checklist-images").join(id)),
            "图片不在本实例目录内",
        )?;
        std::fs::remove_file(checked).map_err(|e| e.to_string())
    }
    fn image_bytes(&self, i: &Instance, path: &str) -> Result<Vec<u8>, String> {
        let media_type = i
            .entries
            .iter()
            .find_map(|e| {
                if let Entry::Image {
                    path: saved,
                    media_type,
                    ..
                } = e
                {
                    if saved == path {
                        Some(media_type.as_str())
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .ok_or("仅允许读取本实例登记的图片")?;
        let file = self.image_file(&i.id, path)?;
        let metadata =
            std::fs::symlink_metadata(&file).map_err(|e| format!("无法读取图片：{e}"))?;
        ensure(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= validate::MAX_IMAGE as u64,
            "本地图片无效或超过限制",
        )?;
        let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
        validate::image(&bytes, media_type)?;
        Ok(bytes)
    }
    pub fn read_image(&self, instance_id: &str, path: &str) -> Result<String, String> {
        let workspace = self.workspace()?;
        let i = find(&workspace, instance_id)?;
        let bytes = self.image_bytes(i, path)?;
        let media_type = i
            .entries
            .iter()
            .find_map(|e| {
                if let Entry::Image {
                    path: p,
                    media_type,
                    ..
                } = e
                {
                    if p == path {
                        Some(media_type)
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .ok_or("图片不存在")?;
        Ok(format!(
            "data:{media_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
    pub fn attach_image(
        &mut self,
        instance_id: &str,
        step_id: &str,
        _name: &str,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<Workspace, String> {
        validate::image(bytes, media_type)?;
        let mut workspace = self.workspace()?;
        let i = find_mut(&mut workspace, instance_id)?;
        ensure(
            i.document.steps.iter().any(|s| s.id == step_id),
            "找不到步骤",
        )?;
        let extension = match media_type {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => return Err("图片类型无效".into()),
        };
        let id = new_id();
        let path = format!("images/{id}.{extension}");
        let at = now();
        i.entries.push(Entry::Image {
            id,
            step_id: step_id.into(),
            at: at.clone(),
            path: path.clone(),
            media_type: media_type.into(),
            caption: String::new(),
        });
        i.updated_at = at;
        validate::workspace(&workspace)?;
        let destination = self.image_file(instance_id, &path)?;
        atomic_write(&destination, bytes)?;
        if let Err(error) = self.save(&workspace) {
            let _ = std::fs::remove_file(destination);
            return Err(error);
        }
        Ok(workspace)
    }
}
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn find<'a>(workspace: &'a Workspace, id: &str) -> Result<&'a Instance, String> {
    workspace
        .instances
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| "找不到实例".into())
}
fn find_mut<'a>(workspace: &'a mut Workspace, id: &str) -> Result<&'a mut Instance, String> {
    let instance = workspace
        .instances
        .iter_mut()
        .find(|i| i.id == id)
        .ok_or_else(|| String::from("找不到实例"))?;
    instance.format_version = 2;
    Ok(instance)
}
fn current_index(i: &Instance) -> Result<usize, String> {
    i.document
        .steps
        .iter()
        .position(|s| Some(&s.id) == i.current_step_id.as_ref())
        .ok_or_else(|| "当前步骤无效".into())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无效保存路径")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_delete_failure_keeps_template_instance_and_registered_images() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        store
            .apply(Action::CreateInstance {
                id: "work".into(),
                template_id: Some("demo-patch-template".into()),
                from_instance_id: None,
                name: "work".into(),
            })
            .unwrap();
        let bytes = include_bytes!(
            "../../../docs/examples/patch-maintenance/images/package-check-demo.png"
        );
        let before = store
            .attach_image("work", "s1-target", "test.png", "image/png", bytes)
            .unwrap();
        let path = match &before.instances[0].entries[0] {
            Entry::Image { path, .. } => path.clone(),
            _ => panic!("expected image"),
        };
        store
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        for action in [
            Action::DeleteTemplate {
                id: "demo-patch-template".into(),
            },
            Action::DeleteInstance { id: "work".into() },
        ] {
            assert!(store.apply(action).is_err());
            assert_eq!(store.workspace().unwrap(), before);
            assert!(store.read_image("work", &path).is_ok());
            assert_eq!(
                std::fs::read(store.image_file("work", &path).unwrap()).unwrap(),
                bytes
            );
        }
        drop(store);
        let reopened = Store::open(directory.path()).unwrap();
        assert_eq!(reopened.workspace().unwrap(), before);
        assert!(reopened.read_image("work", &path).is_ok());
    }

    #[test]
    fn sqlite_commit_failure_does_not_publish_mutation_or_remove_original_image() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        store
            .apply(Action::CreateInstance {
                id: "work".into(),
                template_id: Some("demo-patch-template".into()),
                from_instance_id: None,
                name: "work".into(),
            })
            .unwrap();
        let bytes = include_bytes!(
            "../../../docs/examples/patch-maintenance/images/package-check-demo.png"
        );
        let before = store
            .attach_image("work", "s1-target", "test.png", "image/png", bytes)
            .unwrap();
        let image = before.instances[0].entries[0].clone();
        store
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert!(store
            .apply(Action::DeleteEntry {
                id: "work".into(),
                entry_id: image.id().into()
            })
            .is_err());
        assert_eq!(before, store.workspace().unwrap());
        if let Entry::Image { path, .. } = image {
            assert!(store.read_image("work", &path).is_ok());
        } else {
            panic!("expected image");
        }
    }
}
