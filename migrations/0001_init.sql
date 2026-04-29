CREATE TABLE IF NOT EXISTS contest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_contest_type TEXT NOT NULL DEFAULT 'video',
  music_categories_json TEXT NOT NULL DEFAULT '[]',
  voting_closed_video INTEGER NOT NULL DEFAULT 0,
  voting_closed_bgm INTEGER NOT NULL DEFAULT 0,
  reset_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO contest_state (
  id,
  public_contest_type,
  music_categories_json,
  voting_closed_video,
  voting_closed_bgm,
  reset_version,
  updated_at
) VALUES (
  1,
  'video',
  '[]',
  0,
  0,
  1,
  '2026-04-29T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS employees (
  employee_number TEXT PRIMARY KEY,
  voter_name TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  contest_type TEXT NOT NULL,
  title TEXT NOT NULL,
  submitter TEXT NOT NULL,
  description TEXT NOT NULL,
  music_category TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  media_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_contest_type ON videos (contest_type);
CREATE INDEX IF NOT EXISTS idx_videos_music_category ON videos (music_category);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_number TEXT NOT NULL,
  voter_name TEXT NOT NULL,
  contest_type TEXT NOT NULL,
  video_ids_json TEXT NOT NULL,
  selections_by_category_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT NOT NULL,
  UNIQUE(employee_number, contest_type)
);

CREATE INDEX IF NOT EXISTS idx_votes_contest_type ON votes (contest_type);
