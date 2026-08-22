-- Drishti console store.
--
-- Two things live here, and they are different in kind.
--
-- 1. The *hierarchy* (project > centre > recording) is user-authored. Nothing
--    is seeded. A centre named "Dahisar" exists only because someone typed it,
--    because a fixture centre in the sidebar is a claim that a centre exists.
--
-- 2. The *decisions* are the beginning of a training set. They are append-only:
--    a reviewer who changes their mind writes a second row, and the first one
--    stays. The recursive-learning pipeline needs the reversal as much as the
--    verdict -- "confirmed then dismissed" is a harder and more informative
--    example than either alone. Nothing in this file ever deletes a decision.
--
-- The console reads the *latest* decision per (video, track) through the
-- `current_decision` view. The table underneath keeps everything.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_utc  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS centres (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_utc  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS centres_by_project ON centres(project_id);

-- `processed` is not a boolean the user sets; it is derived from whether a
-- bundle path was registered. A recording with no run must say "not run"
-- rather than showing an empty dashboard, which reads as "nothing was found".
CREATE TABLE IF NOT EXISTS videos (
  id           TEXT PRIMARY KEY,
  centre_id    TEXT NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  media_url    TEXT,
  bundle_url   TEXT,
  overlay_url  TEXT,
  crops_url    TEXT,
  source_path  TEXT,
  duration_ms  INTEGER,
  created_utc  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS videos_by_centre ON videos(centre_id);

-- Append-only. No UPDATE, no DELETE.
--
-- `decision` uses the contract's own vocabulary so a row can be replayed into
-- the pipeline without translation: human_confirmed / human_dismissed are the
-- two states fusion.assert_machine_state() refuses to write, and this is the
-- only place they may come from. `needs_better_view` is the reviewer
-- abstaining, which is a third answer and never a quiet dismissal.
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  track_id      INTEGER NOT NULL,
  decision      TEXT NOT NULL
                CHECK (decision IN ('human_confirmed',
                                    'human_dismissed',
                                    'needs_better_view')),
  -- What the machine had said at the moment the human answered. Without this
  -- a dismissal is unusable as a label: "wrong" is only meaningful against
  -- what was claimed.
  machine_state TEXT,
  key_class     TEXT,
  key_verdict   TEXT,
  key_pts_ms    REAL,
  -- Optional label fields for the future training pass. Left null by the
  -- current UI rather than guessed.
  object_truth     TEXT,
  evidence_quality TEXT,
  policy_context   TEXT,
  note          TEXT,
  reviewer      TEXT NOT NULL DEFAULT 'local',
  decided_utc   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_by_video ON decisions(video_id, track_id, id);

-- Latest answer per person. The history stays in `decisions`.
CREATE VIEW IF NOT EXISTS current_decision AS
SELECT d.*
FROM decisions d
JOIN (
  SELECT video_id, track_id, MAX(id) AS id
  FROM decisions
  GROUP BY video_id, track_id
) last ON last.id = d.id;
