use crate::{
    document::parse_document_structure, model::*, parse_document, refresh_run, resolve_document,
    source_hash, valid_parameter_name,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

fn uuid(value: &str, label: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| format!("{label} 的 ID 不是 UUID"))?;
    if parsed.to_string() != value {
        return Err(format!("{label} 的 ID 必须使用标准小写 UUID"));
    }
    Ok(())
}

fn insert_id(ids: &mut HashSet<String>, value: &str, label: &str) -> Result<(), String> {
    uuid(value, label)?;
    if !ids.insert(value.to_owned()) {
        return Err(format!("{label} ID 重复"));
    }
    Ok(())
}

fn valid_document(markdown: &str, label: &str) -> Result<Document, String> {
    let document = parse_document(markdown);
    if let Some(error) = document.diagnostics.first() {
        return Err(format!("{label} 第 {} 行：{}", error.line, error.message));
    }
    Ok(document)
}

fn normalized(value: &str) -> String {
    value.replace("\r\n", "\n")
}

pub fn validate_parameter_values(parameters: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(name) = parameters.keys().find(|name| !valid_parameter_name(name)) {
        return Err(format!("无效参数名：{name}"));
    }
    Ok(())
}

fn valid_resolved_document(
    markdown: &str,
    parameters: &BTreeMap<String, String>,
    label: &str,
) -> Result<Document, String> {
    validate_parameter_values(parameters)?;
    let resolved =
        resolve_document(markdown, parameters).map_err(|error| format!("{label}：{error}"))?;
    if &resolved.parameters != parameters {
        return Err(format!("{label} 参数与声明不一致"));
    }
    Ok(resolved.document)
}

// Historical snapshots may have different source ranges after a harmless move.
// Compare their semantic content, preserving all whitespace except CRLF/LF.
fn same_content(a: &StepDefinition, b: &StepDefinition) -> bool {
    a.id == b.id
        && a.title == b.title
        && a.content_hash == b.content_hash
        && normalized(&a.markdown) == normalized(&b.markdown)
        && a.commands.len() == b.commands.len()
        && a.commands.iter().zip(&b.commands).all(|(a, b)| {
            a.id == b.id && a.language == b.language && normalized(&a.text) == normalized(&b.text)
        })
}

fn validate_snapshot(snapshot: &StepDefinition) -> Result<(), String> {
    uuid(&snapshot.id, "步骤快照")?;
    if snapshot.start >= snapshot.end {
        return Err("步骤快照源码范围无效".into());
    }
    if snapshot.content_hash != source_hash(&normalized(&snapshot.markdown)) {
        return Err("步骤快照内容摘要不符".into());
    }
    let source = format!("<!-- runbook:document version=\"1\" -->\n\n<!-- runbook:step id=\"{}\" -->\n{}<!-- /runbook:step -->\n", snapshot.id, snapshot.markdown);
    let parsed = parse_document_structure(&source, false);
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("步骤快照第 {} 行：{}", error.line, error.message));
    }
    if parsed.steps.len() != 1 || !same_content(snapshot, &parsed.steps[0]) {
        return Err("步骤快照正文与标题或指令不一致".into());
    }
    let mut last_end = snapshot.start;
    for command in &snapshot.commands {
        uuid(&command.id, "指令快照")?;
        if command.start < last_end || command.start >= command.end || command.end > snapshot.end {
            return Err("指令快照源码范围无效".into());
        }
        last_end = command.end;
    }
    Ok(())
}

pub fn validate_workspace(workspace: &Workspace) -> Result<(), String> {
    let mut template_ids = HashSet::new();
    let mut run_ids = HashSet::new();
    let mut attempt_ids = HashSet::new();
    let mut annotation_ids = HashSet::new();
    for template in &workspace.templates {
        insert_id(&mut template_ids, &template.id, "模板")?;
        if template.name.trim().is_empty() {
            return Err("模板名称不能为空".into());
        }
        if template.revision == 0 || template.applied_revision > template.revision {
            return Err("模板版本无效".into());
        }
        let document = valid_document(&template.applied_markdown, "模板已应用文档")?;
        if document.source_hash != template.source_hash {
            return Err("模板源文档摘要不符".into());
        }
    }
    for run in &workspace.runs {
        insert_id(&mut run_ids, &run.id, "实例")?;
        if run.name.trim().is_empty() || run.initial_template_snapshot.name.trim().is_empty() {
            return Err("实例或来源快照名称不能为空".into());
        }
        if run.revision == 0 || run.applied_revision > run.revision {
            return Err("实例版本无效".into());
        }
        if let Some(id) = &run.source_template_id {
            uuid(id, "来源模板")?;
            if !template_ids.contains(id) {
                return Err("实例来源模板关联不存在".into());
            }
        }
        if let Some(id) = &run.initial_template_snapshot.template_id {
            uuid(id, "初始模板快照")?;
        }
        valid_resolved_document(
            &run.initial_template_snapshot.markdown,
            &run.initial_template_snapshot.parameters,
            "初始模板快照",
        )?;
        let document =
            valid_resolved_document(&run.applied_markdown, &run.parameters, "实例已应用文档")?;
        validate_parameter_values(&run.draft_parameters)?;
        let mut step_ids = HashSet::new();
        for step in &run.steps {
            insert_id(&mut step_ids, &step.step_id, "实例步骤")?;
            if step.step_id != step.definition.id || step.content_version == 0 {
                return Err("步骤身份或内容版本无效".into());
            }
            validate_snapshot(&step.definition)?;
            let current = document
                .steps
                .iter()
                .enumerate()
                .find(|(_, definition)| definition.id == step.step_id);
            match (step.present, current) {
                (true, Some((position, definition)))
                    if position as u32 == step.position && definition == &step.definition => {}
                (false, None) => {}
                _ => return Err("当前步骤投影与已应用文档不一致".into()),
            }
            let mut snapshots: HashMap<u32, &StepDefinition> = HashMap::new();
            let mut last_version = 0;
            let mut drafts = 0;
            for (index, attempt) in step.attempts.iter().enumerate() {
                insert_id(&mut attempt_ids, &attempt.id, "轮次")?;
                validate_parameter_values(&attempt.parameters)?;
                if attempt.attempt_no != index as u32 + 1 {
                    return Err("轮次序号必须从 1 连续递增".into());
                }
                if attempt.content_version == 0
                    || attempt.content_version > step.content_version
                    || attempt.content_version < last_version
                {
                    return Err("轮次内容版本无效".into());
                }
                last_version = attempt.content_version;
                if attempt.document_revision == 0 || attempt.document_revision > run.revision {
                    return Err("轮次文档版本无效".into());
                }
                validate_snapshot(&attempt.step_snapshot)?;
                if attempt.step_snapshot.id != step.step_id {
                    return Err("轮次快照关联的步骤不符".into());
                }
                if let Some(previous) =
                    snapshots.insert(attempt.content_version, &attempt.step_snapshot)
                {
                    if !same_content(previous, &attempt.step_snapshot) {
                        return Err("同一内容版本的轮次快照不一致".into());
                    }
                }
                if attempt.content_version == step.content_version
                    && !same_content(&step.definition, &attempt.step_snapshot)
                {
                    return Err("当前内容版本的轮次快照与步骤不一致".into());
                }
                if matches!(attempt.outcome, Outcome::Failed | Outcome::Skipped)
                    && attempt.note.trim().is_empty()
                {
                    return Err("失败或跳过的轮次缺少说明".into());
                }
                if attempt.outcome == Outcome::Draft {
                    drafts += 1;
                    if !step.present
                        || attempt.content_version != step.content_version
                        || index + 1 != step.attempts.len()
                        || attempt.finished_at.is_some()
                        || !attempt.annotations.is_empty()
                    {
                        return Err("草稿轮次状态或关联无效".into());
                    }
                } else if attempt.finished_at.is_none() {
                    return Err("终态轮次缺少结束时间".into());
                }
                let mut effective = attempt.outcome;
                for annotation in &attempt.annotations {
                    insert_id(&mut annotation_ids, &annotation.id, "追加记录")?;
                    if annotation.text.trim().is_empty() {
                        return Err("追加记录缺少说明".into());
                    }
                    if !matches!(
                        attempt.outcome,
                        Outcome::Completed | Outcome::Failed | Outcome::Skipped
                    ) {
                        return Err("只有已结束结果可以追加说明或更正".into());
                    }
                    match (annotation.previous_outcome, annotation.corrected_outcome) {
                        (None, None) => {}
                        (Some(previous), Some(corrected))
                            if previous == effective
                                && matches!(
                                    corrected,
                                    Outcome::Completed | Outcome::Failed | Outcome::Skipped
                                ) =>
                        {
                            effective = corrected
                        }
                        _ => return Err("结果更正链无效".into()),
                    }
                }
            }
            if drafts > 1 {
                return Err("同一步骤存在多轮草稿".into());
            }
            if run.closed_at.is_some() && drafts > 0 {
                return Err("已留档实例仍有草稿轮次".into());
            }
        }
        if document.steps.len() != run.steps.iter().filter(|step| step.present).count() {
            return Err("已应用文档包含缺失的步骤投影".into());
        }
        if let Some(selected) = &run.selected_step_id {
            if !run
                .steps
                .iter()
                .any(|step| step.present && step.step_id == *selected)
            {
                return Err("选中步骤不属于当前流程".into());
            }
        }
        if run.closed_at.is_some()
            && (run.draft_markdown != run.applied_markdown
                || run.draft_parameters != run.parameters)
        {
            return Err("已留档实例仍有未应用源码或参数".into());
        }
        let mut computed = run.clone();
        refresh_run(&mut computed);
        if computed.summary != run.summary
            || computed
                .steps
                .iter()
                .zip(&run.steps)
                .any(|(computed, stored)| computed.status != stored.status)
        {
            return Err("实例汇总或步骤状态与记录不一致".into());
        }
    }
    Ok(())
}
