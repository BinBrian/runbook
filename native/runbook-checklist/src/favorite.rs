use crate::{model::*, validate::ensure};
use std::collections::{BTreeMap, BTreeSet};

/// Capture saved definitions only. Applied values, entries and execution times
/// never enter a favorite, including when the source work is already finished.
pub(crate) fn capture(
    source: &Instance,
    id: String,
    name: String,
    step_id: Option<&str>,
    group_id: Option<&str>,
) -> Result<Template, String> {
    ensure(
        step_id.is_some() ^ group_id.is_some(),
        "请选择一个步骤或一个完整步骤组",
    )?;
    let group = if let Some(group_id) = group_id {
        Some(
            source
                .document
                .groups
                .iter()
                .find(|g| g.id == group_id)
                .ok_or("来源步骤组已不存在")?,
        )
    } else {
        None
    };
    let steps: Vec<_> = source
        .document
        .steps
        .iter()
        .filter(|s| {
            step_id == Some(s.id.as_str())
                || group_id.is_some() && s.group_id.as_deref() == group_id
        })
        .collect();
    ensure(!steps.is_empty(), "来源步骤已不存在")?;
    let selected: BTreeSet<_> = steps.iter().map(|s| s.id.as_str()).collect();
    let mut referenced = BTreeSet::new();
    for step in &steps {
        for part in step
            .title
            .iter()
            .chain(&step.description)
            .chain(step.commands.iter().flat_map(|c| &c.text))
        {
            if let TextPart::Parameter(p) = part {
                referenced.insert(p.parameter_id.as_str());
            }
        }
    }
    let parameters: Vec<_> = source
        .document
        .parameters
        .iter()
        .filter(|p| {
            referenced.contains(p.id.as_str())
                || p.owner_id
                    .as_deref()
                    .is_some_and(|owner| selected.contains(owner) || group_id == Some(owner))
        })
        .collect();
    let next_group = new_id();
    let step_ids: BTreeMap<_, _> = steps.iter().map(|s| (s.id.clone(), new_id())).collect();
    let parameter_ids: BTreeMap<_, _> = parameters
        .iter()
        .map(|p| (p.id.clone(), new_id()))
        .collect();
    let remap = |parts: &TextParts| -> TextParts {
        parts
            .iter()
            .map(|part| match part {
                TextPart::Text(text) => TextPart::Text(text.clone()),
                TextPart::Parameter(p) => TextPart::Parameter(ParameterRef {
                    parameter_id: parameter_ids[&p.parameter_id].clone(),
                }),
            })
            .collect()
    };
    let info = FavoriteInfo {
        kind: if step_id.is_some() {
            FavoriteKind::Step
        } else {
            FavoriteKind::Group
        },
        source_work_id: source.id.clone(),
        source_work_name: source.name.clone(),
        source_step_ids: steps.iter().map(|s| s.id.clone()).collect(),
        source_group_id: group_id.map(String::from),
    };
    let parameters = parameters
        .iter()
        .map(|p| Parameter {
            id: parameter_ids[&p.id].clone(),
            name: p.name.clone(),
            description: p.description.clone(),
            default_value: p.default_value.clone(),
            owner_id: Some(if let Some(single) = step_id {
                step_ids[single].clone()
            } else {
                p.owner_id
                    .as_ref()
                    .and_then(|owner| step_ids.get(owner))
                    .cloned()
                    .unwrap_or_else(|| next_group.clone())
            }),
        })
        .collect();
    let steps = steps
        .iter()
        .map(|s| Step {
            id: step_ids[&s.id].clone(),
            group_id: Some(next_group.clone()),
            title: remap(&s.title),
            description: remap(&s.description),
            commands: s
                .commands
                .iter()
                .map(|c| Command {
                    id: new_id(),
                    text: remap(&c.text),
                })
                .collect(),
        })
        .collect();
    let at = now();
    Ok(Template {
        favorite: Some(info),
        format_version: 2,
        kind: "block".into(),
        id,
        name: name.clone(),
        document: Document {
            groups: vec![Group {
                id: next_group,
                name: group.map_or_else(|| name.clone(), |g| g.name.clone()),
                description: group.map_or_else(String::new, |g| g.description.clone()),
                source_block_id: None,
            }],
            steps,
            parameters,
        },
        created_at: at.clone(),
        updated_at: at,
    })
}
