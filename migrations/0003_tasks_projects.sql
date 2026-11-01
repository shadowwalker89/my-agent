-- Migration 0003: tasks, projects, intent_feedback (Phase 1-a, design v3 §4).
-- Applied MANUALLY by the human to the remote DB and verified BEFORE any
-- code merge. No column is dropped or renamed. Apply once, in order.
-- The old reminders table is NOT deleted. If it has rows, copy them
-- manually before the code merge (skip the copy when it has no rows):
--   pending -> open with remind_at = due_at:
--   INSERT INTO tasks (user_id, title, status, remind_at, source, created_at)
--     SELECT user_id, text, 'open', due_at, 'text', created_at
--     FROM reminders WHERE status = 'pending';
--   sent/cancelled -> done with reminded_at = COALESCE(sent_at, due_at):
--   INSERT INTO tasks (user_id, title, status, remind_at, reminded_at, completed_at, source, created_at)
--     SELECT user_id, text, 'done', due_at, COALESCE(sent_at, due_at), COALESCE(sent_at, due_at), 'text', created_at
--     FROM reminders WHERE status IN ('sent', 'cancelled');

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT,
  aliases TEXT,
  status TEXT DEFAULT 'active',
  is_default INTEGER DEFAULT 0,
  created_at TEXT,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  title TEXT,
  project_id INTEGER,
  status TEXT DEFAULT 'open',
  due_at TEXT,
  remind_at TEXT,
  reminded_at TEXT,
  remind_attempts INTEGER DEFAULT 0,
  source TEXT DEFAULT 'text',
  source_message_id INTEGER,
  created_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_remind ON tasks(status, remind_at);

CREATE TABLE IF NOT EXISTS intent_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  text TEXT,
  predicted_type TEXT,
  correct_type TEXT,
  project TEXT,
  created_at TEXT
);

ALTER TABLE notes ADD COLUMN project_id INTEGER;

-- Seed one project set per existing user (aliases match SEED_PROJECTS).
INSERT OR IGNORE INTO projects (user_id, name, aliases, status, is_default, created_at)
  SELECT id, 'عمومی', '[]', 'active', 1, datetime('now') FROM users;
INSERT OR IGNORE INTO projects (user_id, name, aliases, status, is_default, created_at)
  SELECT id, 'ایجنت', '[]', 'active', 0, datetime('now') FROM users;
INSERT OR IGNORE INTO projects (user_id, name, aliases, status, is_default, created_at)
  SELECT id, 'گلبهار', '["گل"]', 'active', 0, datetime('now') FROM users;
INSERT OR IGNORE INTO projects (user_id, name, aliases, status, is_default, created_at)
  SELECT id, 'قرارها و ملاقات‌ها', '["قرارها"]', 'active', 0, datetime('now') FROM users;

-- Old notes attach to their owner's default project (عمومی).
UPDATE notes SET project_id = (
  SELECT id FROM projects
  WHERE projects.user_id = notes.user_id AND projects.name = 'عمومی' AND projects.is_default = 1
) WHERE project_id IS NULL;
