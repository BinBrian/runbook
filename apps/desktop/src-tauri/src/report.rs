use runbook_core::{resolve_document, Outcome, Run};
use std::collections::BTreeMap;

fn outcome(value: Outcome) -> &'static str {
    match value {
        Outcome::Draft => "记录中",
        Outcome::Completed => "完成",
        Outcome::Failed => "失败",
        Outcome::Skipped => "跳过",
        Outcome::Withdrawn => "撤回",
    }
}

fn fence(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let marker = "`".repeat(longest.max(2) + 1);
    format!("{marker}text\n{text}\n{marker}\n")
}
fn parameter_text(parameters: &BTreeMap<String, String>) -> String {
    if parameters.is_empty() {
        "未设置参数。\n".into()
    } else {
        fence(&serde_json::to_string_pretty(parameters).expect("string maps always serialize"))
    }
}

pub fn render(run: &Run) -> Result<String, String> {
    let initial = resolve_document(
        &run.initial_template_snapshot.markdown,
        &run.initial_template_snapshot.parameters,
    )?;
    let applied = resolve_document(&run.applied_markdown, &run.parameters)?;
    let conclusion = match run.summary.conclusion.as_str() {
        "no_steps" => "没有步骤",
        "failed" => "含失败",
        "incomplete" => "未完成",
        "completed_with_skips" => "含跳过",
        "completed" => "全部完成",
        value => value,
    };
    let mut report = format!("# {}\n\n实例 ID：{}\n\n创建时间：{}\n\n结束时间：{}\n\n当前结论：{}\n\n完成 {} · 失败 {} · 跳过 {} · 待处理 {} · 记录中 {}\n\n背景：{}\n\n总结：{}\n\n", run.name, run.id, run.created_at, run.closed_at.as_deref().unwrap_or("进行中"), conclusion, run.summary.completed, run.summary.failed, run.summary.skipped, run.summary.pending, run.summary.active, run.context, run.summary_note);
    report.push_str("记录由操作者填写，指令为本轮记录开始时的文档快照。\n\n");
    report.push_str(&format!(
        "## 初始模板快照\n\n来源：{} · 版本 {}\n\n{}\n\n## 当前操作文档\n\n{}\n",
        run.initial_template_snapshot.name,
        run.initial_template_snapshot.revision,
        fence(&initial.markdown),
        fence(&applied.markdown)
    ));
    report.push_str(&format!(
        "\n### 创建时参数\n\n{}\n### 当前已应用参数\n\n{}\n",
        parameter_text(&run.initial_template_snapshot.parameters),
        parameter_text(&run.parameters)
    ));
    if run.draft_markdown != run.applied_markdown || run.draft_parameters != run.parameters {
        report.push_str(&format!(
            "## 尚未应用的流程草稿\n\n以下草稿尚未用于执行。\n\n{}\n",
            fence(&run.draft_markdown)
        ));
        report.push_str(&format!(
            "\n草稿参数（尚未应用）\n\n{}\n",
            parameter_text(&run.draft_parameters)
        ));
    }
    for step in &run.steps {
        report.push_str(&format!(
            "## {}{}\n\n",
            step.definition.title,
            if step.present { "" } else { "（已移除）" }
        ));
        if step.attempts.is_empty() {
            report.push_str("尚无操作记录。\n\n");
        }
        for attempt in &step.attempts {
            report.push_str(&format!(
                "### 第 {} 轮 · {}\n\n内容版本 {}，记录时间 {}，结束时间 {}\n\n",
                attempt.attempt_no,
                outcome(attempt.outcome),
                attempt.content_version,
                attempt.created_at,
                attempt.finished_at.as_deref().unwrap_or("尚未结束")
            ));
            report.push_str(&fence(&attempt.step_snapshot.markdown));
            report.push_str(&format!(
                "\n本轮参数快照\n\n{}\n",
                parameter_text(&attempt.parameters)
            ));
            report.push_str(&format!(
                "\n回显\n\n{}\n说明\n\n{}\n",
                fence(&attempt.output_text),
                fence(&attempt.note)
            ));
            for note in &attempt.annotations {
                let change = match (note.previous_outcome, note.corrected_outcome) {
                    (Some(before), Some(after)) => {
                        format!(" · {} → {}", outcome(before), outcome(after))
                    }
                    _ => String::new(),
                };
                report.push_str(&format!(
                    "\n追加记录 {}{}\n\n{}\n",
                    note.created_at,
                    change,
                    fence(&note.text)
                ));
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use runbook_store::{Action, Request, Store};
    #[test]
    fn output_fences_cannot_close_the_report_block() {
        let text = "中文\n```\n# 回显中的标题\n`````";
        assert_eq!(fence(text), format!("``````text\n{text}\n``````\n"));
    }

    #[test]
    fn report_resolves_initial_and_current_values_but_keeps_historical_parameters() {
        let template_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
        let run_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string();
        let step_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string();
        let attempt_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd".to_string();
        let markdown = format!("<!-- runbook:document version=\"1\" -->\n\n<!-- runbook:parameters {{\"HOST\":\"default\"}} -->\n\n<!-- runbook:step id=\"{step_id}\" -->\n\n## Host {{{{rb:HOST}}}}\n\n<!-- /runbook:step -->\n");
        let mut store = Store::memory().unwrap();
        let mut counter = 0;
        let mut mutate = |action, expected_revision| {
            counter += 1;
            store
                .perform(Request {
                    operation_id: format!("00000000-0000-4000-8000-{counter:012}"),
                    expected_revision,
                    action,
                })
                .unwrap()
        };
        mutate(
            Action::CreateTemplate {
                id: template_id.clone(),
                name: "Source".into(),
                markdown: markdown.clone(),
            },
            None,
        );
        mutate(
            Action::CreateRun {
                id: run_id.clone(),
                template_id: Some(template_id),
                from_run_id: None,
                name: "Report".into(),
                context: String::new(),
                parameters: BTreeMap::from([("HOST".into(), "original-host".into())]),
            },
            None,
        );
        mutate(
            Action::FinishAttempt {
                run_id: run_id.clone(),
                step_id,
                attempt_id,
                outcome: Outcome::Completed,
                output_text: String::new(),
                note: String::new(),
            },
            Some(1),
        );
        mutate(
            Action::SaveRunDraft {
                id: run_id.clone(),
                markdown,
                parameters: Some(BTreeMap::from([(
                    "HOST".into(),
                    "current {{rb:LITERAL}} host".into(),
                )])),
            },
            Some(2),
        );
        let workspace = mutate(Action::ApplyRunDraft { id: run_id }, Some(3));
        let report = render(&workspace.runs[0]).unwrap();
        assert!(report.contains("## Host original-host"));
        assert!(report.contains("## Host current {{rb:LITERAL}} host"));
        assert!(report.contains("本轮参数快照"));
        assert_eq!(
            workspace.runs[0].steps[0].attempts[0].parameters["HOST"],
            "original-host"
        );
    }
}
