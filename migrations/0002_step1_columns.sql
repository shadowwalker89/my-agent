-- Migration 0002: Step 1 columns.
-- Before applying, the human must verify: SELECT COUNT(*) FROM expenses; must be 0.
-- If it is not 0, STOP and do not apply this migration.

ALTER TABLE messages ADD COLUMN kind TEXT DEFAULT 'chat';
ALTER TABLE messages ADD COLUMN tg_file_id TEXT;
ALTER TABLE messages ADD COLUMN file_name TEXT;
ALTER TABLE messages ADD COLUMN file_mime TEXT;

ALTER TABLE reminders ADD COLUMN status TEXT DEFAULT 'pending';
ALTER TABLE reminders ADD COLUMN sent_at TEXT;

DROP TABLE IF EXISTS expenses;
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT DEFAULT 'expense',
  amount INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  item TEXT,
  category TEXT,
  date TEXT,
  note TEXT,
  draft_id TEXT UNIQUE,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
CREATE INDEX IF NOT EXISTS idx_messages_user_kind ON messages(user_id, kind, created_at);
