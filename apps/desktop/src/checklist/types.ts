export type TextPart = string | { parameterId: string };
export type TextParts = TextPart[];
export interface Parameter { id: string; name: string; description: string; defaultValue: string; ownerId?: string }
export interface Command { id: string; text: TextParts }
export interface Step { id: string; title: TextParts; description: TextParts; commands: Command[]; groupId?: string }
export interface StepGroup { id: string; name: string; description?: string; sourceBlockId?: string }
export interface ChecklistDocument { parameters: Parameter[]; steps: Step[]; groups?: StepGroup[] }
export interface Template { formatVersion: 1 | 2; kind: 'template'; id: string; name: string; document: ChecklistDocument; createdAt: string; updatedAt: string }
export interface FavoriteInfo { kind: 'step' | 'group'; sourceWorkId: string; sourceWorkName: string; sourceStepIds: string[]; sourceGroupId?: string }
export interface BlockDefinition { formatVersion: 2; kind: 'block'; id: string; name: string; document: ChecklistDocument; createdAt: string; updatedAt: string; favorite?: FavoriteInfo }
export type ArtifactKind = 'template' | 'instance' | 'block';
export type Outcome = 'completed' | 'failed' | 'skipped';
export interface Snapshot { title: string; description: string; commands: { id: string; text: string }[]; parameterValues: Record<string, string> }
interface EntryBase { id: string; stepId: string; at: string }
export interface ResultEntry extends EntryBase { type: 'result'; outcome: Outcome; reason: string | null; snapshot: Snapshot }
export interface CommentEntry extends EntryBase { type: 'comment'; text: string; editedAt: string | null }
export interface ImageEntry extends EntryBase { type: 'image'; path: string; mediaType: string; caption: string }
export type Entry = ResultEntry | CommentEntry | ImageEntry;
export type InstanceStatus = 'draft' | 'in_progress' | 'completed' | 'terminated';
export interface Instance {
  formatVersion: 1 | 2; kind: 'instance'; id: string; name: string; sourceTemplateId: string | null; sourceInstanceId?: string;
  createdAt: string; startedAt: string | null; updatedAt: string; status: InstanceStatus;
  currentStepId: string | null; finishedAt: string | null; terminationReason: string | null; archivedAt: string | null;
  document: ChecklistDocument; parameterValues: Record<string, string>; entries: Entry[];
}
export interface Workspace { templates: Template[]; instances: Instance[]; blocks?: BlockDefinition[] }
export interface WorkLoad { workspace: Workspace; convertedTemplates: Record<string, string> }
export type Action =
  | { type: 'capture_favorite'; id: string; name: string; sourceId: string; stepId: string | null; groupId: string | null; replaceId: string | null }
  | { type: 'rename_favorite'; id: string; name: string }
  | { type: 'create_work'; id: string; name: string; document: ChecklistDocument }
  | { type: 'repeat_work'; id: string; name: string; sourceId: string; carryValues: boolean }
  | { type: 'create_template'; id: string; name: string; document: ChecklistDocument }
  | { type: 'save_template'; id: string; name: string; document: ChecklistDocument }
  | { type: 'delete_template'; id: string }
  | { type: 'create_block'; id: string; name: string; document: ChecklistDocument }
  | { type: 'save_block'; id: string; name: string; document: ChecklistDocument }
  | { type: 'delete_block'; id: string }
  | { type: 'create_instance'; id: string; templateId: string | null; fromInstanceId: string | null; name: string }
  | { type: 'save_instance'; id: string; name: string; document: ChecklistDocument }
  | { type: 'delete_instance'; id: string }
  | { type: 'apply_parameters'; id: string; values: Record<string, string> }
  | { type: 'start_instance'; id: string }
  | { type: 'record_result'; id: string; outcome: Outcome; reason: string | null }
  | { type: 'terminate_instance'; id: string; reason: string }
  | { type: 'archive_instance'; id: string; archived: boolean }
  | { type: 'save_as_template'; id: string; templateId: string; name: string }
  | { type: 'add_comment'; id: string; stepId: string; entryId: string; text: string }
  | { type: 'edit_comment'; id: string; entryId: string; text: string }
  | { type: 'delete_entry'; id: string; entryId: string };
export interface ImportPreview { token: string; kind: ArtifactKind; name: string; id: string; duplicate: boolean }
export interface FileData { name: string; bytes: number[] }
