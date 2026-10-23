CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    import_source_json TEXT
);
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    source_template_id TEXT REFERENCES templates(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    payload TEXT NOT NULL,
    import_source_json TEXT
);
CREATE TABLE run_steps (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
    step_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    content_version INTEGER NOT NULL CHECK(content_version >= 1),
    present INTEGER NOT NULL CHECK(present IN (0,1)),
    payload TEXT NOT NULL,
    PRIMARY KEY(run_id,step_id)
);
CREATE TABLE step_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
    outcome TEXT NOT NULL CHECK(outcome IN ('draft','completed','failed','skipped','withdrawn')),
    payload TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    import_source_json TEXT,
    FOREIGN KEY(run_id,step_id) REFERENCES run_steps(run_id,step_id) ON DELETE RESTRICT,
    UNIQUE(run_id,step_id,attempt_no)
);
CREATE UNIQUE INDEX one_draft_per_step ON step_attempts(run_id,step_id) WHERE outcome='draft';
CREATE TABLE attempt_annotations (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES step_attempts(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    payload TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    import_source_json TEXT,
    UNIQUE(attempt_id,sequence)
);
CREATE TABLE operation_receipts (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX template_updated ON templates(updated_at);
CREATE INDEX run_lifecycle_updated ON runs(closed_at,updated_at);
