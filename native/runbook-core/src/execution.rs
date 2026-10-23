use crate::{model::*, resolve_document};
use std::collections::{HashMap, HashSet};

pub fn effective_outcome(attempt: &Attempt) -> Outcome {
    attempt
        .annotations
        .iter()
        .filter_map(|annotation| annotation.corrected_outcome)
        .last()
        .unwrap_or(attempt.outcome)
}

pub fn refresh_run(run: &mut Run) {
    let mut summary = Summary::default();
    for step in &mut run.steps {
        let current = step
            .attempts
            .iter()
            .filter(|attempt| attempt.content_version == step.content_version)
            .max_by_key(|attempt| attempt.attempt_no);
        step.status = match current.map(effective_outcome) {
            Some(Outcome::Draft) => StepStatus::Active,
            Some(Outcome::Completed) => StepStatus::Completed,
            Some(Outcome::Failed) => StepStatus::Failed,
            Some(Outcome::Skipped) => StepStatus::Skipped,
            Some(Outcome::Withdrawn) | None => StepStatus::Pending,
        };
        if !step.present {
            summary.removed += 1;
            continue;
        }
        match step.status {
            StepStatus::Pending => summary.pending += 1,
            StepStatus::Active => summary.active += 1,
            StepStatus::Completed => summary.completed += 1,
            StepStatus::Failed => summary.failed += 1,
            StepStatus::Skipped => summary.skipped += 1,
        }
    }
    summary.conclusion =
        if summary.pending + summary.active + summary.completed + summary.failed + summary.skipped
            == 0
        {
            "no_steps"
        } else if summary.failed > 0 {
            "failed"
        } else if summary.pending + summary.active > 0 {
            "incomplete"
        } else if summary.skipped > 0 {
            "completed_with_skips"
        } else {
            "completed"
        }
        .into();
    run.summary = summary;
    if !run
        .steps
        .iter()
        .any(|step| step.present && Some(&step.step_id) == run.selected_step_id.as_ref())
    {
        run.selected_step_id = run
            .steps
            .iter()
            .filter(|step| step.present)
            .min_by_key(|step| step.position)
            .map(|step| step.step_id.clone());
    }
}

pub fn apply_document(run: &mut Run, markdown: &str) -> Result<(), String> {
    if run.closed_at.is_some() {
        return Err("已留档实例不能调整流程".into());
    }
    let resolved = resolve_document(markdown, &run.draft_parameters)?;
    let document = resolved.document;
    let definitions: HashMap<&str, &StepDefinition> = document
        .steps
        .iter()
        .map(|step| (step.id.as_str(), step))
        .collect();
    // Validate the entire change before mutation so a rejected apply is atomic.
    for step in &run.steps {
        let definition = definitions.get(step.step_id.as_str());
        let changes = definition.is_none_or(|value| {
            !step.present || value.content_hash != step.definition.content_hash
        });
        if changes
            && step
                .attempts
                .iter()
                .any(|attempt| attempt.outcome == Outcome::Draft)
        {
            return Err(format!(
                "步骤“{}”正在记录，请先结束或作废该轮次",
                step.definition.title
            ));
        }
        if changes && definition.is_some() && step.content_version == u32::MAX {
            return Err("步骤内容版本已达到上限".into());
        }
    }
    let previously_present: HashSet<String> = run
        .steps
        .iter()
        .filter(|step| step.present)
        .map(|step| step.step_id.clone())
        .collect();
    for step in &mut run.steps {
        step.present = false;
    }
    for (position, definition) in document.steps.into_iter().enumerate() {
        if let Some(step) = run
            .steps
            .iter_mut()
            .find(|step| step.step_id == definition.id)
        {
            let was_present = previously_present.contains(&step.step_id);
            if !was_present || step.definition.content_hash != definition.content_hash {
                step.content_version += 1;
            }
            step.position = position as u32;
            step.present = true;
            step.definition = definition;
        } else {
            run.steps.push(RunStep {
                step_id: definition.id.clone(),
                content_version: 1,
                position: position as u32,
                present: true,
                definition,
                attempts: vec![],
                status: StepStatus::Pending,
            });
        }
    }
    run.applied_markdown = markdown.to_owned();
    run.draft_markdown = markdown.to_owned();
    run.parameters = resolved.parameters;
    run.draft_parameters = run.parameters.clone();
    refresh_run(run);
    Ok(())
}
