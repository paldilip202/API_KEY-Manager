CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS request_logs (
  id BIGSERIAL PRIMARY KEY,
  key_id UUID NOT NULL REFERENCES api_keys(id),
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_key_time
  ON request_logs (key_id, created_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  key_id UUID NOT NULL REFERENCES api_keys(id),
  day DATE NOT NULL,
  requests BIGINT NOT NULL DEFAULT 0,
  errors BIGINT NOT NULL DEFAULT 0,
  total_latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS monthly_quota INTEGER;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS webhook_url TEXT;