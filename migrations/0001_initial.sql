PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sync_cursors (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  cursor TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE content_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  canonical_uri TEXT NOT NULL UNIQUE,
  published_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  media_json TEXT NOT NULL
);

CREATE TABLE content_tags (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY (content_id, value)
);

CREATE TABLE content_labels (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY (content_id, value)
);

CREATE TABLE manual_interests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  value TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE source_preferences (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  preference TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, source_id)
);

CREATE TABLE learned_adjustments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  factor TEXT NOT NULL,
  adjustment REAL NOT NULL,
  provenance_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE editions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE edition_items (
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  recommendation_json TEXT NOT NULL,
  PRIMARY KEY (edition_id, content_id),
  UNIQUE (edition_id, position)
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  content_id TEXT REFERENCES content_items(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);

CREATE TABLE keeps (
  owner_id TEXT NOT NULL,
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  kept_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, content_id)
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_content_items_canonical_uri ON content_items(canonical_uri);
CREATE INDEX idx_content_items_source_published_at ON content_items(source_id, published_at DESC);
CREATE INDEX idx_edition_items_edition_position ON edition_items(edition_id, position);
CREATE INDEX idx_interactions_occurred_at ON interactions(occurred_at DESC);
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);
