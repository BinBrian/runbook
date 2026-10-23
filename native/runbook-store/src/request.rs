use runbook_core::Outcome;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// Stable operation IDs survive a transport retry. Revision is concurrency control,
/// and is deliberately excluded from the operation's business fingerprint.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub expected_revision: Option<u32>,
    pub action: Action,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    CreateTemplate {
        id: String,
        name: String,
        markdown: String,
    },
    SaveTemplate {
        id: String,
        name: String,
        description: String,
        markdown: String,
    },
    ArchiveTemplate {
        id: String,
        archived: bool,
    },
    CreateRun {
        id: String,
        template_id: Option<String>,
        from_run_id: Option<String>,
        name: String,
        context: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        parameters: BTreeMap<String, String>,
    },
    SaveRunDraft {
        id: String,
        markdown: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parameters: Option<BTreeMap<String, String>>,
    },
    ApplyRunDraft {
        id: String,
    },
    DiscardRunDraft {
        id: String,
    },
    SetSelectedStep {
        id: String,
        step_id: Option<String>,
    },
    UpdateRun {
        id: String,
        name: String,
        context: String,
    },
    BeginAttempt {
        run_id: String,
        step_id: String,
        id: String,
    },
    SaveAttempt {
        run_id: String,
        step_id: String,
        attempt_id: String,
        output_text: String,
        note: String,
    },
    FinishAttempt {
        run_id: String,
        step_id: String,
        attempt_id: String,
        outcome: Outcome,
        output_text: String,
        note: String,
    },
    AnnotateAttempt {
        run_id: String,
        step_id: String,
        attempt_id: String,
        id: String,
        text: String,
        corrected_outcome: Option<Outcome>,
    },
    CloseRun {
        id: String,
        summary_note: String,
    },
    ImportBundle {
        json: String,
    },
}
