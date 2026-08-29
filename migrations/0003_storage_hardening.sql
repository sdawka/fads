ALTER TABLE api_idempotency ADD COLUMN state TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE api_idempotency ADD COLUMN claim_token TEXT;
ALTER TABLE api_idempotency ADD COLUMN claimed_at TEXT;
ALTER TABLE api_idempotency ADD COLUMN completed_at TEXT;

CREATE INDEX idx_api_idempotency_claim ON api_idempotency(owner_id, scope, key, state);

CREATE TABLE source_sync_work (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('processed', 'duplicate', 'retry', 'failed')),
  completed_at TEXT,
  PRIMARY KEY (owner_id, source_id, fingerprint)
);

CREATE INDEX idx_source_sync_work_claimed_at ON source_sync_work(state, claimed_at);
CREATE UNIQUE INDEX idx_sources_owner_url_active
  ON sources(owner_id, url)
  WHERE deleted_at IS NULL AND url IS NOT NULL;
