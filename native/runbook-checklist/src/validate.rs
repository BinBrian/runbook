use crate::model::*;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FILE: usize = 32 * 1024 * 1024;
pub const MAX_IMAGE: usize = 8 * 1024 * 1024;
pub const MAX_UNPACKED: usize = 64 * 1024 * 1024;

pub fn ensure(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
pub fn identifier(id: &str) -> Result<(), String> {
    ensure(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
        "身份标识无效",
    )?;
    let upper = id.to_ascii_uppercase();
    ensure(
        ![
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&upper.as_str()),
        "身份标识不能使用系统保留名称",
    )
}
pub fn text(value: &str, limit: usize) -> Result<(), String> {
    ensure(
        value.len() <= limit && !value.contains('\0'),
        "文本超过长度限制或含无效字符",
    )
}
pub fn name(value: &str) -> Result<(), String> {
    text(value, 1024)?;
    ensure(!value.trim().is_empty(), "名称不能为空")
}
fn date(value: &str) -> Result<chrono::DateTime<chrono::FixedOffset>, String> {
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "时间格式无效".into())
}
fn parts(value: &TextParts, parameters: &BTreeSet<&str>) -> Result<(), String> {
    ensure(value.len() <= 4000, "文本片段过多")?;
    for part in value {
        match part {
            TextPart::Text(s) => text(s, 1024 * 1024)?,
            TextPart::Parameter(p) => ensure(
                parameters.contains(p.parameter_id.as_str()),
                "引用了不存在或在本步骤不可见的参数",
            )?,
        }
    }
    Ok(())
}
pub fn document(doc: &Document) -> Result<(), String> {
    ensure(
        !doc.steps.is_empty() && doc.steps.len() <= 2000,
        "流程需包含 1 至 2000 个步骤",
    )?;
    ensure(doc.parameters.len() <= 1000, "参数数量超过限制")?;
    ensure(doc.groups.len() <= 2000, "步骤组数量超过限制")?;
    let mut gids = BTreeSet::new();
    for g in &doc.groups {
        identifier(&g.id)?;
        ensure(gids.insert(g.id.as_str()), "步骤组身份重复")?;
        text(&g.name, 1024)?;
        text(&g.description, 1024 * 1024)?;
        if let Some(source) = &g.source_block_id {
            identifier(source)?;
        }
    }
    let sids: BTreeSet<_> = doc.steps.iter().map(|s| s.id.as_str()).collect();
    ensure(gids.is_disjoint(&sids), "步骤与步骤组身份不能相同")?;
    let mut pids = BTreeSet::new();
    for p in &doc.parameters {
        identifier(&p.id)?;
        ensure(pids.insert(p.id.as_str()), "参数身份重复")?;
        name(&p.name)?;
        text(&p.description, 65536)?;
        text(&p.default_value, 1024 * 1024)?;
        if let Some(owner) = &p.owner_id {
            ensure(
                gids.contains(owner.as_str()) || sids.contains(owner.as_str()),
                "局部参数所属步骤或步骤组不存在",
            )?;
        }
    }
    let mut sids = BTreeSet::new();
    let mut cids = BTreeSet::new();
    let mut seen_groups = BTreeSet::new();
    let mut previous_group = None;
    for s in &doc.steps {
        identifier(&s.id)?;
        ensure(sids.insert(s.id.as_str()), "步骤身份重复")?;
        if let Some(group) = s.group_id.as_deref() {
            ensure(gids.contains(group), "步骤所属组不存在")?;
            if previous_group != Some(group) {
                ensure(seen_groups.insert(group), "同组步骤必须连续")?;
            }
        }
        previous_group = s.group_id.as_deref();
        let visible = doc
            .parameters
            .iter()
            .filter(|p| {
                p.owner_id.is_none()
                    || p.owner_id.as_deref() == Some(s.id.as_str())
                    || p.owner_id
                        .as_ref()
                        .is_some_and(|owner| Some(owner) == s.group_id.as_ref())
            })
            .map(|p| p.id.as_str())
            .collect();
        parts(&s.title, &visible)?;
        parts(&s.description, &visible)?;
        ensure(!s.title.is_empty(), "步骤标题不能为空")?;
        ensure(s.commands.len() <= 1000, "步骤命令过多")?;
        for c in &s.commands {
            identifier(&c.id)?;
            ensure(cids.insert(c.id.as_str()), "命令身份重复")?;
            parts(&c.text, &visible)?;
        }
    }
    ensure(seen_groups.len() == gids.len(), "步骤组至少包含一个步骤")?;
    Ok(())
}
fn version(version: u32, doc: &Document) -> Result<(), String> {
    ensure(version == 1 || version == 2, "格式版本不支持")?;
    ensure(
        version == 2
            || (doc.groups.is_empty()
                && doc.parameters.iter().all(|p| p.owner_id.is_none())
                && doc.steps.iter().all(|s| s.group_id.is_none())),
        "局部参数与步骤组需要 formatVersion=2",
    )
}
pub fn values(doc: &Document, values: &Values, required: bool) -> Result<(), String> {
    let pids: BTreeSet<_> = doc.parameters.iter().map(|p| p.id.as_str()).collect();
    for (id, value) in values {
        ensure(pids.contains(id.as_str()), "参数值引用了不存在的参数")?;
        text(value, 1024 * 1024)?;
    }
    if required {
        for s in &doc.steps {
            for set in std::iter::once(&s.title)
                .chain(std::iter::once(&s.description))
                .chain(s.commands.iter().map(|c| &c.text))
            {
                for part in set {
                    if let TextPart::Parameter(p) = part {
                        ensure(
                            values
                                .get(&p.parameter_id)
                                .is_some_and(|v| !v.trim().is_empty()),
                            "请补齐流程引用的参数后再开始或应用",
                        )?;
                    }
                }
            }
        }
    }
    Ok(())
}
/// Local values become immutable when their owning step, or every step in their
/// owning group, has advanced. Global values may still change for future work.
pub fn frozen_local_parameters(value: &Instance) -> BTreeSet<&str> {
    let advanced: BTreeSet<_> = value
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Result {
                step_id, outcome, ..
            } if *outcome != Outcome::Failed => Some(step_id.as_str()),
            _ => None,
        })
        .collect();
    value
        .document
        .parameters
        .iter()
        .filter(|parameter| {
            parameter.owner_id.as_deref().is_some_and(|owner| {
                if value.document.steps.iter().any(|step| step.id == owner) {
                    advanced.contains(owner)
                } else {
                    let members: Vec<_> = value
                        .document
                        .steps
                        .iter()
                        .filter(|step| step.group_id.as_deref() == Some(owner))
                        .collect();
                    !members.is_empty()
                        && members
                            .iter()
                            .all(|step| advanced.contains(step.id.as_str()))
                }
            })
        })
        .map(|p| p.id.as_str())
        .collect()
}
pub fn template(value: &Template) -> Result<(), String> {
    ensure(value.kind == "template", "模板类型或格式版本不支持")?;
    version(value.format_version, &value.document)?;
    identifier(&value.id)?;
    name(&value.name)?;
    document(&value.document)?;
    ensure(
        date(&value.created_at)? <= date(&value.updated_at)?,
        "模板时间顺序无效",
    )
}
pub fn block(value: &Template) -> Result<(), String> {
    ensure(
        value.kind == "block" && value.format_version == 2,
        "步骤块类型或格式版本不支持",
    )?;
    identifier(&value.id)?;
    name(&value.name)?;
    if let Some(info) = &value.favorite {
        identifier(&info.source_work_id)?;
        name(&info.source_work_name)?;
        if let Some(id) = &info.source_group_id {
            identifier(id)?;
        }
        ensure(
            info.source_step_ids.len() == value.document.steps.len(),
            "收藏来源步骤数量无效",
        )?;
        let mut source_ids = BTreeSet::new();
        for id in &info.source_step_ids {
            identifier(id)?;
            ensure(source_ids.insert(id), "收藏来源步骤身份重复")?;
        }
        if info.kind == FavoriteKind::Step {
            ensure(
                value.document.steps.len() == 1 && info.source_group_id.is_none(),
                "单步收藏只能包含一个步骤",
            )?;
            ensure(
                value
                    .document
                    .parameters
                    .iter()
                    .all(|p| p.owner_id.as_ref() == Some(&value.document.steps[0].id)),
                "单步收藏变量必须属于本步骤",
            )?;
        } else {
            ensure(info.source_group_id.is_some(), "组收藏缺少来源组身份")?;
        }
    }
    document(&value.document)?;
    ensure(value.document.groups.len() == 1, "步骤块必须恰有一个步骤组")?;
    let group = &value.document.groups[0].id;
    ensure(
        value
            .document
            .steps
            .iter()
            .all(|s| s.group_id.as_ref() == Some(group)),
        "步骤块中的全部步骤必须属于本组",
    )?;
    ensure(
        value
            .document
            .parameters
            .iter()
            .all(|p| p.owner_id.is_some()),
        "步骤块参数必须定义在本组或组内步骤中",
    )?;
    ensure(
        date(&value.created_at)? <= date(&value.updated_at)?,
        "步骤块时间顺序无效",
    )
}
pub fn image_path(path: &str) -> Result<(), String> {
    let rest = path
        .strip_prefix("images/")
        .ok_or("图片必须位于 images/ 下")?;
    ensure(
        !rest.is_empty()
            && !rest.contains('/')
            && !rest.contains('\\')
            && rest != "."
            && rest != ".."
            && rest.len() <= 200
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
        "图片路径无效",
    )?;
    let stem = rest.split('.').next().unwrap_or("").to_ascii_uppercase();
    ensure(
        ![
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
            && !rest.ends_with('.'),
        "图片文件名无效",
    )
}
pub fn image(bytes: &[u8], media_type: &str) -> Result<(), String> {
    ensure(
        !bytes.is_empty() && bytes.len() <= MAX_IMAGE,
        "图片必须小于 8 MiB",
    )?;
    let valid = match media_type {
        "image/png" => {
            bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                && bytes.len() >= 24
                && &bytes[12..16] == b"IHDR"
        }
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]),
        "image/webp" => bytes.len() >= 16 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/gif" => {
            bytes.len() >= 13 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
        }
        _ => false,
    };
    ensure(valid, "只接受签名与类型一致的 PNG、JPEG、WebP 或 GIF 图片")
}
pub fn instance(value: &Instance) -> Result<(), String> {
    ensure(value.kind == "instance", "实例类型或格式版本不支持")?;
    version(value.format_version, &value.document)?;
    identifier(&value.id)?;
    name(&value.name)?;
    document(&value.document)?;
    values(&value.document, &value.parameter_values, false)?;
    let created = date(&value.created_at)?;
    let updated = date(&value.updated_at)?;
    ensure(created <= updated, "实例时间顺序无效")?;
    if let Some(start) = &value.started_at {
        ensure(
            created <= date(start)? && date(start)? <= updated,
            "开始时间无效",
        )?;
    }
    if let Some(finish) = &value.finished_at {
        ensure(
            value
                .started_at
                .as_ref()
                .is_some_and(|s| date(s).is_ok_and(|s| s <= date(finish).unwrap_or(s))),
            "结束时间早于开始时间",
        )?;
        ensure(date(finish)? <= updated, "结束时间晚于更新时间")?;
    }
    if let Some(archived) = &value.archived_at {
        ensure(
            matches!(value.status, Status::Completed | Status::Terminated),
            "只有已完成或终止实例可以归档",
        )?;
        ensure(
            value
                .finished_at
                .as_ref()
                .is_some_and(|f| date(f).is_ok_and(|f| f <= date(archived).unwrap_or(f)))
                && date(archived)? <= updated,
            "归档时间无效",
        )?;
    }
    ensure(value.entries.len() <= 20000, "记录数量超过限制")?;
    let sids: BTreeSet<_> = value.document.steps.iter().map(|s| s.id.as_str()).collect();
    let mut eids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut cursor = 0;
    let mut last = created;
    let mut final_results = BTreeMap::new();
    for entry in &value.entries {
        identifier(entry.id())?;
        ensure(eids.insert(entry.id()), "记录身份重复")?;
        ensure(sids.contains(entry.step_id()), "记录引用不存在的步骤")?;
        let at = date(entry.at())?;
        ensure(at >= last && at <= updated, "记录时间顺序无效")?;
        last = at;
        match entry {
            Entry::Result {
                step_id,
                outcome,
                reason,
                snapshot: snap,
                ..
            } => {
                ensure(
                    value
                        .started_at
                        .as_ref()
                        .is_some_and(|s| date(s).is_ok_and(|s| s <= at)),
                    "结果早于开始时间",
                )?;
                ensure(
                    value
                        .finished_at
                        .as_ref()
                        .is_none_or(|f| date(f).is_ok_and(|f| at <= f)),
                    "结束后不得追加执行结果",
                )?;
                ensure(
                    cursor < value.document.steps.len()
                        && value.document.steps[cursor].id == *step_id,
                    "执行结果不符合单向步骤顺序",
                )?;
                if *outcome != Outcome::Completed {
                    name(reason.as_deref().unwrap_or(""))?;
                }
                if let Some(r) = reason {
                    text(r, 65536)?;
                }
                text(&snap.title, 1024 * 1024)?;
                text(&snap.description, 1024 * 1024)?;
                ensure(
                    snap.commands.len() <= 1000 && snap.parameter_values.len() <= 1000,
                    "结果快照超过限制",
                )?;
                let mut command_ids = BTreeSet::new();
                for c in &snap.commands {
                    identifier(&c.id)?;
                    ensure(command_ids.insert(&c.id), "快照命令身份重复")?;
                    text(&c.text, 1024 * 1024)?;
                }
                for (id, v) in &snap.parameter_values {
                    identifier(id)?;
                    text(v, 1024 * 1024)?;
                }
                if *outcome != Outcome::Failed {
                    final_results.insert(cursor, snap);
                    cursor += 1;
                }
            }
            Entry::Comment {
                text: comment,
                edited_at,
                ..
            } => {
                text(comment, 1024 * 1024)?;
                ensure(!comment.trim().is_empty(), "评论不能为空")?;
                if let Some(edited) = edited_at {
                    ensure(
                        at <= date(edited)? && date(edited)? <= updated,
                        "评论修改时间无效",
                    )?;
                }
            }
            Entry::Image {
                path,
                media_type,
                caption,
                ..
            } => {
                image_path(path)?;
                ensure(paths.insert(path.to_lowercase()), "图片路径重复")?;
                ensure(
                    ["image/png", "image/jpeg", "image/webp", "image/gif"]
                        .contains(&media_type.as_str()),
                    "图片类型无效",
                )?;
                text(caption, 65536)?;
            }
        }
    }
    for (index, saved) in final_results {
        // A final result freezes the visible content as well as the commands and values.
        ensure(
            snapshot(&value.document.steps[index], &saved.parameter_values) == *saved,
            "已推进步骤的内容与最终结果快照不一致",
        )?;
        if value.format_version == 2 {
            let step = &value.document.steps[index];
            for part in std::iter::once(&step.title)
                .chain(std::iter::once(&step.description))
                .chain(step.commands.iter().map(|c| &c.text))
                .flatten()
            {
                if let TextPart::Parameter(parameter) = part {
                    ensure(
                        saved
                            .parameter_values
                            .get(&parameter.parameter_id)
                            .is_some_and(|v| !v.trim().is_empty()),
                        "最终结果快照缺少已使用的参数值",
                    )?;
                }
            }
        }
    }
    match value.status {
        Status::Draft => ensure(
            value.started_at.is_none()
                && value.finished_at.is_none()
                && value.current_step_id.is_none()
                && cursor == 0
                && !value
                    .entries
                    .iter()
                    .any(|e| matches!(e, Entry::Result { .. }))
                && value.termination_reason.is_none(),
            "草稿状态与记录不一致",
        )?,
        Status::InProgress => ensure(
            value.started_at.is_some()
                && value.finished_at.is_none()
                && value.termination_reason.is_none()
                && cursor < value.document.steps.len()
                && value.current_step_id.as_deref()
                    == Some(value.document.steps[cursor].id.as_str()),
            "执行中状态与当前步骤不一致",
        )?,
        Status::Completed => ensure(
            value.started_at.is_some()
                && value.finished_at.is_some()
                && value.current_step_id.is_none()
                && cursor == value.document.steps.len()
                && value.termination_reason.is_none(),
            "已完成状态与记录不一致",
        )?,
        Status::Terminated => {
            ensure(
                value.started_at.is_some()
                    && value.finished_at.is_some()
                    && value.current_step_id.is_none()
                    && cursor < value.document.steps.len(),
                "终止状态与记录不一致",
            )?;
            name(value.termination_reason.as_deref().unwrap_or(""))?;
        }
    }
    Ok(())
}
pub fn workspace(value: &Workspace) -> Result<(), String> {
    ensure(
        value.templates.len() <= 5000
            && value.instances.len() <= 10000
            && value.blocks.len() <= 5000,
        "工作区数量超过限制",
    )?;
    let mut tids = BTreeSet::new();
    let mut iids = BTreeSet::new();
    let mut bids = BTreeSet::new();
    for b in &value.blocks {
        block(b)?;
        ensure(bids.insert(&b.id), "步骤块身份重复")?;
    }
    for t in &value.templates {
        template(t)?;
        ensure(tids.insert(&t.id), "模板身份重复")?;
    }
    for i in &value.instances {
        instance(i)?;
        ensure(iids.insert(i.id.to_ascii_lowercase()), "实例身份重复")?;
    }
    Ok(())
}
