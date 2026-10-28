CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  telegram_id TEXT UNIQUE,
  name TEXT,
  language TEXT DEFAULT 'fa',
  currency TEXT DEFAULT 'تومان',
  timezone TEXT DEFAULT 'Asia/Tehran',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  role TEXT,
  content TEXT,
  model TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind TEXT,
  key TEXT,
  value TEXT,
  updated_at TEXT,
  UNIQUE(user_id, kind, key)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  text TEXT,
  source TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_user_time ON notes(user_id, created_at);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount REAL,
  currency TEXT,
  category TEXT,
  item TEXT,
  date TEXT,
  note TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  r2_key TEXT UNIQUE,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  bin TEXT,
  expires_at TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_bin ON files(bin);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,
  status TEXT,
  input_file_id INTEGER,
  output_file_id INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  text TEXT,
  due_at TEXT,
  done INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, done);
