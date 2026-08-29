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
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  curiosity INTEGER NOT NULL CHECK (curiosity BETWEEN 0 AND 100),
  energy INTEGER NOT NULL CHECK (energy BETWEEN 0 AND 100),
  trace_json TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE edition_items (
  owner_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  recommendation_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, edition_id, content_id),
  UNIQUE (owner_id, edition_id, position),
  FOREIGN KEY (owner_id, edition_id) REFERENCES editions(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE edition_decisions (
  owner_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  content_id TEXT NOT NULL,
  canonical_uri TEXT,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  reason TEXT,
  trace_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, edition_id, decision_key),
  FOREIGN KEY (owner_id, edition_id) REFERENCES editions(owner_id, id) ON DELETE CASCADE
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
CREATE INDEX idx_editions_owner_created_at ON editions(owner_id, created_at DESC);
CREATE INDEX idx_edition_items_edition_position ON edition_items(owner_id, edition_id, position);
CREATE INDEX idx_edition_decisions_edition ON edition_decisions(owner_id, edition_id);
CREATE INDEX idx_interactions_occurred_at ON interactions(occurred_at DESC);
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);
