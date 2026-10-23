use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Values = BTreeMap<String, String>;
pub type TextParts = Vec<TextPart>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TextPart {
    Text(String),
    Parameter(ParameterRef),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParameterRef {
    pub parameter_id: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub text: TextParts,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub title: TextParts,
    pub description: TextParts,
    pub commands: Vec<Command>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_block_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub parameters: Vec<Parameter>,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub groups: Vec<Group>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Template {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<FavoriteInfo>,
    pub format_version: u32,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub document: Document,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FavoriteKind {
    Step,
    Group,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteInfo {
    pub kind: FavoriteKind,
    pub source_work_id: String,
    pub source_work_name: String,
    pub source_step_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_group_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Draft,
    InProgress,
    Completed,
    Terminated,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Skipped,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedCommand {
    pub id: String,
    pub text: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub title: String,
    pub description: String,
    pub commands: Vec<ResolvedCommand>,
    pub parameter_values: Values,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Entry {
    Result {
        id: String,
        #[serde(rename = "stepId")]
        step_id: String,
        at: String,
        outcome: Outcome,
        reason: Option<String>,
        snapshot: Snapshot,
    },
    Comment {
        id: String,
        #[serde(rename = "stepId")]
        step_id: String,
        at: String,
        text: String,
        #[serde(rename = "editedAt")]
        edited_at: Option<String>,
    },
    Image {
        id: String,
        #[serde(rename = "stepId")]
        step_id: String,
        at: String,
        path: String,
        #[serde(rename = "mediaType")]
        media_type: String,
        caption: String,
    },
}
impl Entry {
    pub fn id(&self) -> &str {
        match self {
            Self::Result { id, .. } | Self::Comment { id, .. } | Self::Image { id, .. } => id,
        }
    }
    pub fn step_id(&self) -> &str {
        match self {
            Self::Result { step_id, .. }
            | Self::Comment { step_id, .. }
            | Self::Image { step_id, .. } => step_id,
        }
    }
    pub fn at(&self) -> &str {
        match self {
            Self::Result { at, .. } | Self::Comment { at, .. } | Self::Image { at, .. } => at,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    pub format_version: u32,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub source_template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_instance_id: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub status: Status,
    pub current_step_id: Option<String>,
    pub finished_at: Option<String>,
    pub termination_reason: Option<String>,
    pub archived_at: Option<String>,
    pub document: Document,
    pub parameter_values: Values,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub templates: Vec<Template>,
    pub instances: Vec<Instance>,
    #[serde(default)]
    pub blocks: Vec<Template>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    CaptureFavorite {
        id: String,
        name: String,
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "stepId")]
        step_id: Option<String>,
        #[serde(rename = "groupId")]
        group_id: Option<String>,
        #[serde(rename = "replaceId")]
        replace_id: Option<String>,
    },
    RenameFavorite {
        id: String,
        name: String,
    },
    CreateWork {
        id: String,
        name: String,
        document: Document,
    },
    RepeatWork {
        id: String,
        name: String,
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "carryValues")]
        carry_values: bool,
    },
    CreateBlock {
        id: String,
        name: String,
        document: Document,
    },
    SaveBlock {
        id: String,
        name: String,
        document: Document,
    },
    DeleteBlock {
        id: String,
    },
    CreateTemplate {
        id: String,
        name: String,
        document: Document,
    },
    SaveTemplate {
        id: String,
        name: String,
        document: Document,
    },
    DeleteTemplate {
        id: String,
    },
    CreateInstance {
        id: String,
        #[serde(rename = "templateId")]
        template_id: Option<String>,
        #[serde(rename = "fromInstanceId")]
        from_instance_id: Option<String>,
        name: String,
    },
    SaveInstance {
        id: String,
        name: String,
        document: Document,
    },
    DeleteInstance {
        id: String,
    },
    ApplyParameters {
        id: String,
        values: Values,
    },
    StartInstance {
        id: String,
    },
    RecordResult {
        id: String,
        outcome: Outcome,
        reason: Option<String>,
    },
    TerminateInstance {
        id: String,
        reason: String,
    },
    ArchiveInstance {
        id: String,
        archived: bool,
    },
    SaveAsTemplate {
        id: String,
        #[serde(rename = "templateId")]
        template_id: String,
        name: String,
    },
    AddComment {
        id: String,
        #[serde(rename = "stepId")]
        step_id: String,
        #[serde(rename = "entryId")]
        entry_id: String,
        text: String,
    },
    EditComment {
        id: String,
        #[serde(rename = "entryId")]
        entry_id: String,
        text: String,
    },
    DeleteEntry {
        id: String,
        #[serde(rename = "entryId")]
        entry_id: String,
    },
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn resolve(parts: &TextParts, values: &Values) -> String {
    parts
        .iter()
        .map(|p| match p {
            TextPart::Text(s) => s.as_str(),
            TextPart::Parameter(p) => values
                .get(&p.parameter_id)
                .map(String::as_str)
                .unwrap_or(""),
        })
        .collect()
}
pub fn snapshot(step: &Step, values: &Values) -> Snapshot {
    Snapshot {
        title: resolve(&step.title, values),
        description: resolve(&step.description, values),
        commands: step
            .commands
            .iter()
            .map(|c| ResolvedCommand {
                id: c.id.clone(),
                text: resolve(&c.text, values),
            })
            .collect(),
        parameter_values: values.clone(),
    }
}
