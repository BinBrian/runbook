use runbook_core::*;

const STEP: &str = "11111111-1111-4111-8111-111111111111";
const STEP2: &str = "22222222-2222-4222-8222-222222222222";
const COMMAND: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW: &str = "2026-10-13T08:00:00Z";

fn block(id: &str, body: &str) -> String {
    format!("<!-- runbook:step id=\"{id}\" -->\n\n{body}\n\n<!-- /runbook:step -->\n")
}
fn document(body: &str) -> String {
    format!("<!-- runbook:document version=\"1\" -->\n\n{body}")
}
fn command(fence: &str, text: &str) -> String {
    format!("<!-- runbook:command id=\"{COMMAND}\" -->\n\n{fence}powershell\n{text}\n{fence}\n")
}
fn make_run(source: &str) -> Run {
    let mut run = Run {
        id: "33333333-3333-4333-8333-333333333333".into(),
        name: "Test maintenance".into(),
        context: String::new(),
        source_template_id: None,
        initial_template_snapshot: TemplateSnapshot {
            template_id: None,
            name: "Test".into(),
            revision: 1,
            markdown: source.into(),
            parameters: resolve_document(source, &Default::default())
                .unwrap()
                .parameters,
        },
        draft_markdown: String::new(),
        applied_markdown: String::new(),
        parameters: Default::default(),
        draft_parameters: Default::default(),
        revision: 1,
        applied_revision: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
        closed_at: None,
        summary_note: String::new(),
        selected_step_id: None,
        steps: vec![],
        summary: Summary::default(),
    };
    apply_document(&mut run, source).unwrap();
    run
}
fn attempt(step: &RunStep, number: u32, outcome: Outcome) -> Attempt {
    Attempt {
        id: format!("99999999-9999-4999-8999-{number:012}"),
        attempt_no: number,
        content_version: step.content_version,
        document_revision: 1,
        step_snapshot: step.definition.clone(),
        parameters: Default::default(),
        outcome,
        output_text: String::new(),
        note: "Checked".into(),
        created_at: NOW.into(),
        finished_at: if outcome == Outcome::Draft {
            None
        } else {
            Some(NOW.into())
        },
        annotations: vec![],
    }
}

#[test]
fn parses_repository_example() {
    let source = include_str!("../../../examples/patch-maintenance.runbook.md");
    let parsed = parse_document(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.steps.len(), 3);
    assert_eq!(parsed.steps[0].title, "检查维护窗口");
    assert_eq!(
        parsed.steps[0].commands[0].text,
        "Write-Output '已确认维护窗口'"
    );
    assert!(parsed.steps[2].commands.is_empty());
}

#[test]
fn commands_preserve_exact_whitespace_and_structural_newline() {
    for fence in ["```", "`````", "~~~", "~~~~~"] {
        for text in [
            "echo ok",
            " echo ok  ",
            "中文😀\n\n",
            "\techo ok\n",
            "echo `ok`\n \n",
        ] {
            let source = document(&block(STEP, &format!("# 标题\n\n{}", command(fence, text))));
            let parsed = parse_document(&source);
            assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
            assert_eq!(parsed.steps[0].commands[0].text, text);
            let crlf = source.replace('\n', "\r\n");
            let parsed_crlf = parse_document(&crlf);
            assert!(
                parsed_crlf.diagnostics.is_empty(),
                "{:?}",
                parsed_crlf.diagnostics
            );
            assert_eq!(
                parsed_crlf.steps[0].commands[0].text,
                text.replace('\n', "\r\n")
            );
            assert_eq!(
                parsed.steps[0].content_hash, parsed_crlf.steps[0].content_hash,
                "LF={:?}, CRLF={:?}",
                parsed.steps[0].markdown, parsed_crlf.steps[0].markdown
            );
        }
    }
}

#[test]
fn ignores_fake_markers_inside_code_quotes_lists_and_inline_text() {
    let source = format!("# Read me\n\n```md\n{}\n```\n\n> <!-- runbook:step id=\"{STEP}\" -->\n\n- item\n\n  <!-- runbook:command id=\"{COMMAND}\" -->\n\nInline <!-- runbook:step id=\"{STEP}\" --> text\n", block(STEP, "fake"));
    let parsed = parse_document(&source);
    assert!(parsed.steps.is_empty());
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(plain_markdown(&source).unwrap(), source);
}

#[test]
fn ignores_markers_inside_unrelated_html_blocks_and_comments() {
    for source in [
        format!("<div>\n<!-- runbook:step id=\"{STEP}\" -->\n</div>\n"),
        format!("<!-- example comment\n<!-- runbook:step id=\"{STEP}\" -->\n-->\n"),
    ] {
        let parsed = parse_document(&source);
        assert!(parsed.steps.is_empty());
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        assert_eq!(plain_markdown(&source).unwrap(), source);
    }
}

#[test]
fn plain_export_removes_only_real_markers_and_keeps_commands() {
    let fake = format!("echo '<!-- runbook:step id=\"{STEP2}\" -->'");
    let source = document(&block(
        STEP,
        &format!("# Check\n\n{}", command("```", &fake)),
    ));
    let plain = plain_markdown(&source).unwrap();
    assert!(plain.contains(&fake));
    assert!(plain.contains("```powershell"));
    assert!(!plain.contains("<!-- runbook:document"));
    assert!(!plain.contains("<!-- runbook:command"));
    assert!(!plain.contains("<!-- /runbook:step"));
}

#[test]
fn rejects_invalid_annotation_shapes() {
    let samples = [
        document(&format!("{}{}", block(STEP, "# first"), block(STEP, "# second"))),
        document(&block("invalid", "# broken")),
        document(&block(STEP, &block(STEP2, "# nested"))),
        document(&format!("<!-- runbook:step id=\"{STEP}\" -->\n# open")),
        document(&block(STEP, &format!("# cmd\n\n<!-- runbook:command id=\"{COMMAND}\" -->\n\nparagraph\n\n```sh\necho ok\n```"))),
        document(&block(STEP, &format!("# cmd\n\n{}", command("```", " \t\n")))),
        document(&format!("<!-- runbook:step id=\"{STEP}\" -->\n# cmd\n\n<!-- runbook:command id=\"{COMMAND}\" -->\n```sh\necho unfinished")),
        document(&command("```", "echo outside")),
        "<!-- runbook:document version=\"2\" -->".into(),
        block(STEP, "# missing document marker"),
        document(&block(STEP, "")),
    ];
    for source in samples {
        let parsed = parse_document(&source);
        assert!(
            !parsed.diagnostics.is_empty(),
            "Expected a diagnostic for: {source}"
        );
        assert!(plain_markdown(&source).is_err());
    }
}

#[test]
fn ranges_are_utf8_byte_ranges_for_whole_blocks() {
    let source = format!(
        "# 中文😀\n\n{}",
        document(&block(
            STEP,
            &format!("# 标题😀\n\n{}", command("```", "Write-Output '中文😀'"))
        ))
    );
    let parsed = parse_document(&source);
    assert!(parsed.diagnostics.is_empty());
    let step = &parsed.steps[0];
    let cmd = &step.commands[0];
    assert!(source[step.start as usize..step.end as usize].starts_with("<!-- runbook:step"));
    assert!(source[cmd.start as usize..cmd.end as usize].starts_with("```powershell"));
    assert_eq!(cmd.text, "Write-Output '中文😀'");
}

#[test]
fn move_preserves_result_change_and_restore_require_new_confirmation() {
    let first = block(STEP, "# Check one");
    let second = block(STEP2, "# Check two");
    let mut run = make_run(&document(&format!("{first}{second}")));
    let done = attempt(&run.steps[0], 1, Outcome::Completed);
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    apply_document(&mut run, &document(&format!("{second}{first}"))).unwrap();
    assert_eq!(run.steps[0].content_version, 1);
    assert_eq!(run.steps[0].position, 1);
    assert_eq!(run.steps[0].status, StepStatus::Completed);
    apply_document(
        &mut run,
        &document(&format!("{second}{}", block(STEP, "# Changed"))),
    )
    .unwrap();
    assert_eq!(run.steps[0].content_version, 2);
    assert_eq!(run.steps[0].status, StepStatus::Pending);
    apply_document(&mut run, &document(&format!("{second}{first}"))).unwrap();
    assert_eq!(run.steps[0].content_version, 3);
    assert_eq!(run.steps[0].status, StepStatus::Pending);
    apply_document(&mut run, &document(&second)).unwrap();
    assert!(!run.steps[0].present);
    assert_eq!(run.summary.removed, 1);
    apply_document(&mut run, &document(&format!("{second}{first}"))).unwrap();
    assert_eq!(run.steps[0].content_version, 4);
    assert_eq!(run.steps[0].attempts.len(), 1);
}

#[test]
fn draft_blocks_change_and_removal_atomically_but_allows_move() {
    let first = block(STEP, "# Check one");
    let second = block(STEP2, "# Check two");
    let mut run = make_run(&document(&format!("{first}{second}")));
    let draft = attempt(&run.steps[0], 1, Outcome::Draft);
    run.steps[0].attempts.push(draft);
    refresh_run(&mut run);
    let original = run.clone();
    assert!(apply_document(&mut run, &document(&second)).is_err());
    assert_eq!(original, run);
    assert!(apply_document(
        &mut run,
        &document(&format!("{}{}", block(STEP, "# change"), second))
    )
    .is_err());
    assert_eq!(original, run);
    apply_document(&mut run, &document(&format!("{second}{first}"))).unwrap();
    assert_eq!(run.summary.active, 1);
    assert_eq!(run.steps[0].content_version, 1);
}

#[test]
fn latest_attempt_and_correction_define_summary_without_losing_history() {
    let mut run = make_run(&document(&block(STEP, "# Check")));
    let completed = attempt(&run.steps[0], 1, Outcome::Completed);
    let failed = attempt(&run.steps[0], 2, Outcome::Failed);
    run.steps[0].attempts.extend([completed, failed]);
    refresh_run(&mut run);
    assert_eq!(run.summary.conclusion, "failed");
    run.steps[0].attempts[1].annotations.push(Annotation {
        id: "44444444-4444-4444-8444-444444444444".into(),
        text: "Confirmed afterwards".into(),
        previous_outcome: Some(Outcome::Failed),
        corrected_outcome: Some(Outcome::Completed),
        created_at: NOW.into(),
    });
    refresh_run(&mut run);
    assert_eq!(run.summary.conclusion, "completed");
    assert_eq!(run.steps[0].attempts[1].outcome, Outcome::Failed);
    let withdrawn = attempt(&run.steps[0], 3, Outcome::Withdrawn);
    run.steps[0].attempts.push(withdrawn);
    refresh_run(&mut run);
    assert_eq!(run.summary.conclusion, "incomplete");
    assert_eq!(run.summary.pending, 1);
}

#[test]
fn backup_validation_rejects_forged_snapshot_status_and_closed_draft() {
    let mut run = make_run(&document(&block(
        STEP,
        &format!("# Check\n\n{}", command("```", "echo hello")),
    )));
    let done = attempt(&run.steps[0], 1, Outcome::Completed);
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    let good = Workspace {
        templates: vec![],
        runs: vec![run],
    };
    validate_workspace(&good).unwrap();
    let serialized = serde_json::to_string(&good).unwrap();
    let roundtrip: Workspace = serde_json::from_str(&serialized).unwrap();
    assert_eq!(good, roundtrip);
    for index in 0..7 {
        let mut invalid = good.clone();
        let run = &mut invalid.runs[0];
        match index {
            0 => run.steps[0].attempts[0].step_snapshot.commands[0].text = "echo forged".into(),
            1 => run.steps[0].definition.content_hash = "forged".into(),
            2 => run.summary.conclusion = "failed".into(),
            3 => run.steps[0].attempts[0].finished_at = None,
            4 => {
                run.closed_at = Some(NOW.into());
                run.draft_markdown.push_str("\nUnapplied");
            }
            5 => run.steps[0].attempts[0].content_version = 2,
            _ => run.steps[0].attempts[0].annotations.push(Annotation {
                id: "44444444-4444-4444-8444-444444444444".into(),
                text: "Invalid chain".into(),
                previous_outcome: Some(Outcome::Failed),
                corrected_outcome: Some(Outcome::Skipped),
                created_at: NOW.into(),
            }),
        }
        assert!(validate_workspace(&invalid).is_err(), "case {index}");
    }
}

#[test]
fn backup_validation_allows_historical_ranges_after_move_and_change() {
    let one = block(STEP, "# One");
    let two = block(STEP2, "# Two");
    let mut run = make_run(&document(&format!("{one}{two}")));
    let completed = attempt(&run.steps[0], 1, Outcome::Completed);
    run.steps[0].attempts.push(completed);
    refresh_run(&mut run);
    apply_document(&mut run, &document(&format!("{two}{one}"))).unwrap();
    validate_workspace(&Workspace {
        templates: vec![],
        runs: vec![run.clone()],
    })
    .unwrap();
    apply_document(
        &mut run,
        &document(&format!("{two}{}", block(STEP, "# Edited"))),
    )
    .unwrap();
    validate_workspace(&Workspace {
        templates: vec![],
        runs: vec![run],
    })
    .unwrap();
}

fn parameter_document(definitions: &str, text: &str) -> String {
    document(&format!(
        "<!-- runbook:parameters {definitions} -->\n\n{}",
        block(
            STEP,
            &format!("# Parameter check\n\n{}", command("```", text))
        )
    ))
}

#[test]
fn parameters_default_override_exact_substitution_and_extra_values() {
    let source = parameter_document(
        r#"{"HOST":"默认主机","EMPTY":""}"#,
        "echo {{rb:HOST}} {{HOST}} $HOST {{rb:EMPTY}}",
    );
    let parsed = parse_document(&source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.parameters.len(), 2);
    assert_eq!(parsed.parameters[1].default_value, "");
    let defaults = resolve_document(&source, &Default::default()).unwrap();
    assert_eq!(
        defaults.document.steps[0].commands[0].text,
        "echo 默认主机 {{HOST}} $HOST "
    );
    let values = [
        ("HOST".into(), "  '中文'\nnext\t".into()),
        ("EXTRA".into(), "discarded".into()),
    ]
    .into();
    let resolved = resolve_document(&source, &values).unwrap();
    assert_eq!(
        resolved.document.steps[0].commands[0].text,
        "echo   '中文'\nnext\t {{HOST}} $HOST "
    );
    assert_eq!(resolved.parameters.len(), 2);
    assert!(!resolved.parameters.contains_key("EXTRA"));
    assert!(resolved
        .markdown
        .contains(r#"{"HOST":"默认主机","EMPTY":""}"#));
}

#[test]
fn parameter_definitions_reject_duplicates_bad_names_and_bad_shapes() {
    for definition in [
        r#"{"HOST":"a","HOST":"b"}"#,
        r#"{"HOST":"a","\u0048OST":"b"}"#,
        r#"{"HOST":3}"#,
        r#"{"HOST":null}"#,
        r#"{"HOST":{}}"#,
        r#"[]"#,
        r#"{"1HOST":"a"}"#,
        r#"{"中文":"a"}"#,
        r#"{"":"a"}"#,
        r#"{"HOST-NAME":"a"}"#,
        r#"{"HOST":"a"} {"PORT":"b"}"#,
    ] {
        let source = parameter_document(definition, "echo text");
        assert!(
            !parse_document(&source).diagnostics.is_empty(),
            "{definition}"
        );
        assert!(resolve_document(&source, &Default::default()).is_err());
    }
    assert!(valid_parameter_name(&"A".repeat(64)));
    assert!(!valid_parameter_name(&"A".repeat(65)));
    let duplicate = parameter_document(r#"{"HOST":"a"}"#, "echo {{rb:HOST}}")
        + "\n<!-- runbook:parameters {} -->\n";
    assert!(!parse_document(&duplicate).diagnostics.is_empty());
    let in_step = document(&block(STEP, "# Check\n\n<!-- runbook:parameters {} -->\n"));
    assert!(!parse_document(&in_step).diagnostics.is_empty());
    let multiline = parameter_document("{\n\"HOST\":\"a\"\n}", "echo value");
    assert!(!parse_document(&multiline).diagnostics.is_empty());
}

#[test]
fn nested_parameter_metadata_stays_literal_and_never_declares_values() {
    for nested in [
        "> <!-- runbook:parameters {\"HOST\":\"nested\"} -->\n",
        "- item\n\n  <!-- runbook:parameters {\"HOST\":\"nested\"} -->\n",
        "```md\n<!-- runbook:parameters {\"HOST\":\"nested\"} -->\n```\n",
    ] {
        let source = document(&format!("{nested}\n{}", block(STEP, "# {{rb:HOST}}")));
        let parsed = parse_document(&source);
        assert!(parsed.parameters.is_empty());
        assert!(parsed
            .diagnostics
            .iter()
            .any(|d| d.message.contains("未声明")));
    }
}

#[test]
fn unknown_and_malformed_rb_placeholders_block_apply() {
    for text in [
        "echo {{rb:UNKNOWN}}",
        "echo {{rb:HOST",
        "echo {{rb:HOST }}",
        "echo {{rb:}}",
    ] {
        let source = parameter_document(r#"{"HOST":"a"}"#, text);
        assert!(!parse_document(&source).diagnostics.is_empty(), "{text}");
        assert!(resolve_document(&source, &Default::default()).is_err());
    }
}

#[test]
fn inserted_values_are_literal_and_frozen_snapshots_do_not_resolve_again() {
    let source = parameter_document(
        r#"{"HOST":"{{rb:OTHER}} `literal` --\u003e"}"#,
        "echo {{rb:HOST}}",
    );
    let mut run = make_run(&source);
    let plain = plain_resolved_markdown(&source, &run.parameters).unwrap();
    assert!(plain.contains("echo {{rb:OTHER}} `literal` -->"));
    assert!(!plain.contains("<!-- runbook:"));
    assert_eq!(
        run.steps[0].definition.commands[0].text,
        "echo {{rb:OTHER}} `literal` -->"
    );
    let mut done = attempt(&run.steps[0], 1, Outcome::Completed);
    done.parameters = run.parameters.clone();
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    validate_workspace(&Workspace {
        templates: vec![],
        runs: vec![run],
    })
    .unwrap();
    let recursive = parameter_document(
        r#"{"HOST":"{{rb:OTHER}}","OTHER":"expanded"}"#,
        "echo {{rb:HOST}}",
    );
    assert_eq!(
        resolve_document(&recursive, &Default::default())
            .unwrap()
            .document
            .steps[0]
            .commands[0]
            .text,
        "echo {{rb:OTHER}}"
    );
}

#[test]
fn parameter_values_cannot_change_semantic_identity_or_fence_boundaries() {
    let source = parameter_document(r#"{"HOST":"a"}"#, "echo {{rb:HOST}}");
    for value in [
        "<!-- /runbook:step -->",
        "<!-- runbook:command id=\"x\" -->",
        "value\n```\ntruncated",
        "value\n```\n\n```powershell\ninjected",
    ] {
        assert!(
            resolve_document(&source, &[("HOST".into(), value.into())].into()).is_err(),
            "{value}"
        );
    }
    let language = source.replace("```powershell", "```{{rb:HOST}}");
    assert!(resolve_document(&language, &Default::default()).is_err());
    let identity = source.replace(STEP, "{{rb:HOST}}");
    assert!(resolve_document(&identity, &[("HOST".into(), STEP.into())].into()).is_err());
    let command_identity = source.replace(COMMAND, "{{rb:HOST}}");
    assert!(
        resolve_document(&command_identity, &[("HOST".into(), COMMAND.into())].into()).is_err()
    );
    // A closing fence followed by ordinary text can retain one parsed command, but truncates it.
    let sole_placeholder = parameter_document(r#"{"HOST":"a"}"#, "{{rb:HOST}}");
    assert!(resolve_document(
        &sole_placeholder,
        &[("HOST".into(), "echo ok\n```\nignored".into())].into()
    )
    .is_err());
}

#[test]
fn parameter_change_versions_affected_steps_and_preserves_attempt_values() {
    let source = parameter_document(r#"{"HOST":"old","UNUSED":"first"}"#, "echo {{rb:HOST}}");
    let mut run = make_run(&source);
    let mut done = attempt(&run.steps[0], 1, Outcome::Completed);
    done.parameters = run.parameters.clone();
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    run.draft_parameters.insert("HOST".into(), "new".into());
    apply_document(&mut run, &source).unwrap();
    assert_eq!(run.steps[0].content_version, 2);
    assert_eq!(run.steps[0].status, StepStatus::Pending);
    assert_eq!(run.steps[0].attempts[0].parameters["HOST"], "old");
    assert_eq!(
        run.steps[0].attempts[0].step_snapshot.commands[0].text,
        "echo old"
    );
    let mut done = attempt(&run.steps[0], 2, Outcome::Completed);
    done.parameters = run.parameters.clone();
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    run.draft_parameters
        .insert("UNUSED".into(), "second".into());
    apply_document(&mut run, &source).unwrap();
    assert_eq!(run.steps[0].content_version, 2);
    assert_eq!(run.steps[0].status, StepStatus::Completed);
    validate_workspace(&Workspace {
        templates: vec![],
        runs: vec![run],
    })
    .unwrap();
}

#[test]
fn active_attempt_blocks_affected_parameter_apply_atomically() {
    let source = parameter_document(r#"{"HOST":"old","UNUSED":"first"}"#, "echo {{rb:HOST}}");
    let mut run = make_run(&source);
    let mut draft = attempt(&run.steps[0], 1, Outcome::Draft);
    draft.parameters = run.parameters.clone();
    run.steps[0].attempts.push(draft);
    refresh_run(&mut run);
    run.draft_parameters.insert("HOST".into(), "new".into());
    let before = run.clone();
    assert!(apply_document(&mut run, &source).is_err());
    assert_eq!(run, before);
    run.draft_parameters.insert("HOST".into(), "old".into());
    run.draft_parameters
        .insert("UNUSED".into(), "second".into());
    run.draft_parameters
        .insert("EXTRA".into(), "discard".into());
    apply_document(&mut run, &source).unwrap();
    assert_eq!(run.parameters["UNUSED"], "second");
    assert!(!run.parameters.contains_key("EXTRA"));
    validate_workspace(&Workspace {
        templates: vec![],
        runs: vec![run],
    })
    .unwrap();
}

#[test]
fn parameter_validation_rejects_tampered_projection_maps_and_closed_drafts() {
    let source = parameter_document(r#"{"HOST":"a"}"#, "echo {{rb:HOST}}");
    let mut run = make_run(&source);
    let mut done = attempt(&run.steps[0], 1, Outcome::Completed);
    done.parameters = run.parameters.clone();
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    let good = Workspace {
        templates: vec![],
        runs: vec![run],
    };
    validate_workspace(&good).unwrap();
    for case in 0..7 {
        let mut invalid = good.clone();
        let run = &mut invalid.runs[0];
        match case {
            0 => {
                run.parameters.insert("HOST".into(), "forged".into());
            }
            1 => {
                run.initial_template_snapshot
                    .parameters
                    .insert("MISSING".into(), "extra".into());
            }
            2 => {
                run.steps[0].attempts[0]
                    .parameters
                    .insert("bad-name".into(), "value".into());
            }
            3 => {
                run.steps[0].attempts[0].step_snapshot.commands[0].text = "echo forged".into();
            }
            4 => {
                run.closed_at = Some(NOW.into());
                run.draft_parameters.insert("HOST".into(), "draft".into());
            }
            5 => {
                run.parameters.clear();
            }
            _ => {
                run.draft_parameters
                    .insert("bad-name".into(), "draft".into());
            }
        }
        assert!(validate_workspace(&invalid).is_err(), "case {case}");
    }
    let mut draft = good;
    draft.runs[0].draft_markdown = "<!-- invalid {{rb:".into();
    draft.runs[0]
        .draft_parameters
        .insert("EXTRA".into(), "keep while editing".into());
    validate_workspace(&draft).unwrap();
}

#[test]
fn old_json_without_parameter_fields_remains_valid() {
    let mut run = make_run(&document(&block(STEP, "# Old data")));
    let done = attempt(&run.steps[0], 1, Outcome::Completed);
    run.steps[0].attempts.push(done);
    refresh_run(&mut run);
    let mut value = serde_json::to_value(Workspace {
        templates: vec![],
        runs: vec![run],
    })
    .unwrap();
    let run = &mut value["runs"][0];
    run.as_object_mut().unwrap().remove("parameters");
    run.as_object_mut().unwrap().remove("draft_parameters");
    run["initial_template_snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("parameters");
    run["steps"][0]["attempts"][0]
        .as_object_mut()
        .unwrap()
        .remove("parameters");
    let restored: Workspace = serde_json::from_value(value).unwrap();
    validate_workspace(&restored).unwrap();
    assert!(restored.runs[0].parameters.is_empty());
}

#[test]
fn generated_parameter_contracts_have_required_records() {
    use ts_rs::TS;
    for declaration in [
        Run::decl(),
        TemplateSnapshot::decl(),
        Attempt::decl(),
        ResolvedDocument::decl(),
    ] {
        assert!(
            declaration.contains("parameters: Record<string, string>"),
            "{declaration}"
        );
        assert!(!declaration.contains("parameters?:"), "{declaration}");
    }
    assert!(Run::decl().contains("draft_parameters: Record<string, string>"));
}
