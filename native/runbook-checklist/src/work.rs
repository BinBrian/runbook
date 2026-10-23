use crate::{model::*, validate};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkLoad {
    pub workspace: Workspace,
    pub converted_templates: BTreeMap<String, String>,
}

pub(crate) fn defaults(document: &Document) -> Values {
    document
        .parameters
        .iter()
        .map(|p| (p.id.clone(), p.default_value.clone()))
        .collect()
}
pub(crate) fn fresh(
    id: String,
    name: String,
    document: Document,
    parameter_values: Values,
    source: Option<String>,
) -> Instance {
    let at = now();
    Instance {
        format_version: 2,
        kind: "instance".into(),
        id,
        name,
        source_template_id: None,
        source_instance_id: source,
        created_at: at.clone(),
        updated_at: at,
        started_at: None,
        status: Status::Draft,
        current_step_id: None,
        finished_at: None,
        termination_reason: None,
        archived_at: None,
        document,
        parameter_values,
        entries: Vec::new(),
    }
}
pub(crate) fn from_template(template: &Template, id: String) -> Result<Instance, String> {
    let mut work = fresh(
        id,
        template.name.clone(),
        template.document.clone(),
        defaults(&template.document),
        None,
    );
    work.source_template_id = Some(template.id.clone());
    work.created_at = template.created_at.clone();
    work.updated_at = template.updated_at.clone();
    validate::instance(&work)?;
    Ok(work)
}
