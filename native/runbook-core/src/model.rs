use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub message: String,
    pub line: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub parameters: Vec<ParameterDefinition>,
    pub steps: Vec<StepDefinition>,
    pub diagnostics: Vec<Diagnostic>,
    pub source_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ParameterDefinition {
    pub name: String,
    pub default_value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ResolvedDocument {
    pub markdown: String,
    pub document: Document,
    #[ts(type = "Record<string, string>")]
    pub parameters: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StepDefinition {
    pub id: String,
    pub title: String,
    pub markdown: String,
    pub commands: Vec<CommandDefinition>,
    pub start: u32,
    pub end: u32,
    pub content_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CommandDefinition {
    pub id: String,
    pub language: String,
    pub text: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub draft_markdown: String,
    pub applied_markdown: String,
    pub revision: u32,
    pub applied_revision: u32,
    pub source_hash: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TemplateSnapshot {
    pub template_id: Option<String>,
    pub name: String,
    pub revision: u32,
    pub markdown: String,
    #[serde(default)]
    #[ts(type = "Record<string, string>")]
    pub parameters: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub name: String,
    pub context: String,
    pub source_template_id: Option<String>,
    pub initial_template_snapshot: TemplateSnapshot,
    pub draft_markdown: String,
    pub applied_markdown: String,
    #[serde(default)]
    #[ts(type = "Record<string, string>")]
    pub parameters: BTreeMap<String, String>,
    #[serde(default)]
    #[ts(type = "Record<string, string>")]
    pub draft_parameters: BTreeMap<String, String>,
    pub revision: u32,
    pub applied_revision: u32,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub summary_note: String,
    pub selected_step_id: Option<String>,
    pub steps: Vec<RunStep>,
    pub summary: Summary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RunStep {
    pub step_id: String,
    pub content_version: u32,
    pub position: u32,
    pub present: bool,
    pub definition: StepDefinition,
    pub attempts: Vec<Attempt>,
    pub status: StepStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub id: String,
    pub attempt_no: u32,
    pub content_version: u32,
    pub document_revision: u32,
    pub step_snapshot: StepDefinition,
    #[serde(default)]
    #[ts(type = "Record<string, string>")]
    pub parameters: BTreeMap<String, String>,
    pub outcome: Outcome,
    pub output_text: String,
    pub note: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub annotations: Vec<Annotation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    pub text: String,
    pub previous_outcome: Option<Outcome>,
    pub corrected_outcome: Option<Outcome>,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Draft,
    Completed,
    Failed,
    Skipped,
    Withdrawn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Active,
    Completed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Summary {
    pub pending: u32,
    pub active: u32,
    pub completed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub removed: u32,
    pub conclusion: String,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub templates: Vec<Template>,
    pub runs: Vec<Run>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Backup {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: String,
    pub templates: Vec<Template>,
    pub runs: Vec<Run>,
}
