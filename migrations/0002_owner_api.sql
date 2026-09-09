ALTER TABLE sources ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN url TEXT;
ALTER TABLE sources ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE sources ADD COLUMN last_error TEXT;
ALTER TABLE sources ADD COLUMN last_synced_at TEXT;
ALTER TABLE sources ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_sources_owner_updated_at ON sources(owner_id, updated_at DESC);

CREATE TABLE interest_suggestions (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  evidence_count INTEGER NOT NULL CHECK (evidence_count > 0),
  provenance_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE owner_preferences (
  owner_id TEXT PRIMARY KEY,
  preferences_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE owner_muted_sources (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  muted_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, source_id)
);

CREATE TABLE content_suppressions (
  owner_id TEXT NOT NULL,
  content_id TEXT,
  canonical_uri TEXT,
  until_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (content_id IS NOT NULL OR canonical_uri IS NOT NULL)
);

CREATE INDEX idx_content_suppressions_owner_until ON content_suppressions(owner_id, until_at);

CREATE TABLE api_idempotency (
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_headers_json TEXT NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, scope, key)
);

CREATE INDEX idx_api_idempotency_expiry ON api_idempotency(expires_at);
CREATE INDEX idx_manual_interests_owner_created_at ON manual_interests(owner_id, created_at);
CREATE INDEX idx_learned_adjustments_owner_updated_at ON learned_adjustments(owner_id, updated_at);
