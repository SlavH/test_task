CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  agent_id TEXT,
  call_type TEXT,
  call_status TEXT,
  from_number TEXT,
  to_number TEXT,
  start_timestamp BIGINT,
  end_timestamp BIGINT,
  duration_ms INTEGER,
  transcript TEXT,
  transcript_json JSONB,
  recording_url TEXT,
  disconnection_reason TEXT,
  call_analysis JSONB,
  webhook_last_event TEXT,
  metadata JSONB,
  source TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  service_address TEXT NOT NULL,
  appliance_type TEXT NOT NULL,
  appliance_brand TEXT NOT NULL,
  issue_description TEXT NOT NULL,
  is_warranty BOOLEAN NOT NULL DEFAULT FALSE,
  fee_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'booked',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  caller_name TEXT NOT NULL,
  company TEXT,
  callback_number TEXT NOT NULL,
  job_details TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'message_taken',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  call_id TEXT PRIMARY KEY REFERENCES calls(call_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  caller_name TEXT NOT NULL,
  callback_number TEXT NOT NULL,
  from_number TEXT,
  company TEXT,
  appliance TEXT,
  brand TEXT,
  issue TEXT,
  job_details TEXT,
  reason TEXT,
  service_address TEXT,
  fee_quoted BOOLEAN NOT NULL DEFAULT FALSE,
  fee_accepted BOOLEAN,
  booking_id TEXT REFERENCES bookings(booking_id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  analysis_summary TEXT,
  sentiment TEXT,
  call_successful BOOLEAN,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  transcript_text TEXT NOT NULL DEFAULT '',
  recording_url TEXT,
  disconnection_reason TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'phone',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  telegram_status TEXT NOT NULL DEFAULT 'pending',
  telegram_message_id TEXT
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_key TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS persona_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  warmth TEXT NOT NULL DEFAULT 'warm',
  task_focus TEXT NOT NULL DEFAULT 'task_focused',
  business_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_additions TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_agent_version INTEGER,
  applied_at TIMESTAMPTZ
);

INSERT INTO persona_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS call_notes (
  id SERIAL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_tags (
  id SERIAL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (call_id, tag)
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_started_at ON notifications (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications (type);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls (start_timestamp);
