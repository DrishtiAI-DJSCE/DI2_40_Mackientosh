/**
 * Drishti console API.
 *
 * One process serves three things: the hierarchy the user authors, the
 * decisions they make, and the Cerebras proxy. In development Vite proxies
 * `/api` here; in production this process also serves the built console and
 * the media, so there is exactly one thing to deploy.
 */
import express from "express";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowUtc, openDb, slug } from "./db.js";
import { describeImage } from "./vision.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PUBLIC = join(root, "public");
const DIST = join(root, "dist");

const db = openDb();
const app = express();
app.use(express.json({ limit: "12mb" }));

const bad = (res, code, message) => res.status(code).json({ error: message });

/* ------------------------------------------------------------------ tree */

function tree() {
  const projects = db
    .prepare("SELECT * FROM projects ORDER BY created_utc")
    .all();
  const centres = db.prepare("SELECT * FROM centres ORDER BY created_utc").all();
  const videos = db.prepare("SELECT * FROM videos ORDER BY created_utc").all();
  const decided = db
    .prepare(
      "SELECT video_id, COUNT(*) n FROM current_decision GROUP BY video_id",
    )
    .all();
  const decidedBy = Object.fromEntries(decided.map((r) => [r.video_id, r.n]));

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    centres: centres
      .filter((c) => c.project_id === p.id)
      .map((c) => ({
        id: c.id,
        name: c.name,
        videos: videos
          .filter((v) => v.centre_id === c.id)
          .map((v) => ({
            id: v.id,
            name: v.name,
            video: v.media_url,
            bundle: v.bundle_url,
            overlay: v.overlay_url,
            crops: v.crops_url,
            // Derived, never stored: a recording is processed exactly when a
            // run bundle was registered for it.
            processed: Boolean(v.bundle_url),
            decided: decidedBy[v.id] ?? 0,
          })),
      })),
  }));
}

app.get("/api/tree", (_req, res) => res.json({ projects: tree() }));

app.post("/api/projects", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return bad(res, 400, "A project needs a name.");
  const taken = new Set(
    db.prepare("SELECT id FROM projects").all().map((r) => r.id),
  );
  const id = slug(name, taken);
  db.prepare(
    "INSERT INTO projects (id, name, created_utc) VALUES (?, ?, ?)",
  ).run(id, name, nowUtc());
  res.status(201).json({ id, name, projects: tree() });
});

app.post("/api/projects/:id/centres", (req, res) => {
  const project = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!project) return bad(res, 404, "No such project.");
  const name = String(req.body?.name ?? "").trim();
  if (!name) return bad(res, 400, "A centre needs a name.");
  const taken = new Set(
    db.prepare("SELECT id FROM centres").all().map((r) => r.id),
  );
  const id = slug(`${req.params.id}-${name}`, taken);
  db.prepare(
    "INSERT INTO centres (id, project_id, name, created_utc) VALUES (?,?,?,?)",
  ).run(id, req.params.id, name, nowUtc());
  res.status(201).json({ id, projects: tree() });
});

app.post("/api/centres/:id/videos", (req, res) => {
  const centre = db
    .prepare("SELECT id FROM centres WHERE id = ?")
    .get(req.params.id);
  if (!centre) return bad(res, 404, "No such centre.");
  const name = String(req.body?.name ?? "").trim();
  if (!name) return bad(res, 400, "A recording needs a name.");

  const taken = new Set(
    db.prepare("SELECT id FROM videos").all().map((r) => r.id),
  );
  const id = slug(name, taken);
  const pick = (k) => {
    const v = req.body?.[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  db.prepare(
    `INSERT INTO videos
       (id, centre_id, name, media_url, bundle_url, overlay_url, crops_url,
        source_path, created_utc)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    req.params.id,
    name,
    pick("media_url"),
    pick("bundle_url"),
    pick("overlay_url"),
    pick("crops_url"),
    pick("source_path"),
    nowUtc(),
  );
  res.status(201).json({ id, projects: tree() });
});

// Removing a *container* is allowed; removing a decision is not. Cascades take
// the empty scaffolding with it, and decisions cascade only because a video
// that no longer exists has nothing to label.
app.delete("/api/projects/:id", (req, res) => {
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.json({ projects: tree() });
});
app.delete("/api/centres/:id", (req, res) => {
  db.prepare("DELETE FROM centres WHERE id = ?").run(req.params.id);
  res.json({ projects: tree() });
});
app.delete("/api/videos/:id", (req, res) => {
  db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);
  res.json({ projects: tree() });
});

/* ---------------------------------------------------------------- assets */

/** What is actually on disk, so attaching a recording is a pick, not a typed
 *  path. A path the user could type is a path that can be wrong. */
app.get("/api/assets", (_req, res) => {
  const list = (dir, test) => {
    const full = join(PUBLIC, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full)
      .filter(test)
      .map((f) => ({
        url: `/${dir}/${f}`,
        name: f,
        bytes: statSync(join(full, f)).size,
      }));
  };
  res.json({
    media: list("media", (f) => /\.(mp4|webm|mkv)$/i.test(f)),
    bundles: list("data", (f) => f.endsWith(".json") && !f.includes(".overlay")),
    overlays: list("data", (f) => f.endsWith(".overlay.json")),
    crops: existsSync(join(PUBLIC, "crops"))
      ? readdirSync(join(PUBLIC, "crops"))
          .filter((d) => statSync(join(PUBLIC, "crops", d)).isDirectory())
          .map((d) => ({ url: `/crops/${d}`, name: d, bytes: 0 }))
      : [],
  });
});

/* ------------------------------------------------------------- decisions */

const DECISIONS = new Set([
  "human_confirmed",
  "human_dismissed",
  "needs_better_view",
]);

app.get("/api/videos/:id/decisions", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM current_decision WHERE video_id = ?")
    .all(req.params.id);
  const total = db
    .prepare("SELECT COUNT(*) n FROM decisions WHERE video_id = ?")
    .get(req.params.id).n;
  res.json({
    current: Object.fromEntries(rows.map((r) => [r.track_id, r])),
    revisions: total,
  });
});

app.post("/api/videos/:id/decisions", (req, res) => {
  const video = db
    .prepare("SELECT id FROM videos WHERE id = ?")
    .get(req.params.id);
  if (!video) return bad(res, 404, "No such recording.");

  const decision = String(req.body?.decision ?? "");
  if (!DECISIONS.has(decision)) {
    return bad(
      res,
      400,
      `decision must be one of ${[...DECISIONS].join(", ")}`,
    );
  }
  const trackId = Number(req.body?.track_id);
  if (!Number.isInteger(trackId)) return bad(res, 400, "track_id must be an integer.");

  const info = db
    .prepare(
      `INSERT INTO decisions
         (video_id, track_id, decision, machine_state, key_class, key_verdict,
          key_pts_ms, note, reviewer, decided_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      req.params.id,
      trackId,
      decision,
      req.body?.machine_state ?? null,
      req.body?.key_class ?? null,
      req.body?.key_verdict ?? null,
      req.body?.key_pts_ms ?? null,
      req.body?.note ?? null,
      req.body?.reviewer ?? "local",
      nowUtc(),
    );

  const row = db
    .prepare("SELECT * FROM decisions WHERE id = ?")
    .get(info.lastInsertRowid);
  res.status(201).json(row);
});

/** Everything a human said was not a violation, newest first.
 *
 *  This is the false-positive set. It is the most valuable thing the console
 *  produces: a detection the machine made and a human overturned, with the
 *  machine's own claim attached. */
app.get("/api/videos/:id/dismissed", (req, res) => {
  res.json({
    rows: db
      .prepare(
        `SELECT * FROM current_decision
          WHERE video_id = ? AND decision = 'human_dismissed'
          ORDER BY id DESC`,
      )
      .all(req.params.id),
  });
});

/** The whole label set as JSONL, for the training pass. Includes reversals. */
app.get("/api/labels.jsonl", (_req, res) => {
  const rows = db.prepare("SELECT * FROM decisions ORDER BY id").all();
  res.type("application/x-ndjson");
  res.send(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
});

/* ----------------------------------------------------------------- vision */

app.post("/api/vision", async (req, res) => {
  try {
    const { status, body } = await describeImage(req.body ?? {});
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    vision: Boolean(process.env.CEREBRAS_API_KEY),
    projects: db.prepare("SELECT COUNT(*) n FROM projects").get().n,
    decisions: db.prepare("SELECT COUNT(*) n FROM decisions").get().n,
  }),
);

/* ----------------------------------------------------------------- static */

app.use(express.static(PUBLIC, { maxAge: "1h" }));
if (existsSync(DIST)) {
  app.use(express.static(DIST, { maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(DIST, "index.html")));
}

const port = Number(process.env.PORT ?? 5179);
app.listen(port, () => {
  console.log(`drishti api on http://localhost:${port}`);
  if (!process.env.CEREBRAS_API_KEY) {
    console.log("  (CEREBRAS_API_KEY unset — image description will 503)");
  }
});
