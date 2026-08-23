# Deploying the console

Three pieces, deployed separately because they have genuinely different needs:

| Piece | Where | Why there |
| --- | --- | --- |
| Console + API | Cloudflare Worker (free) | request/response work, no state of its own |
| Decisions + hierarchy | Cloudflare D1 (free, 5 GB) | D1 *is* SQLite — same schema as local |
| Recordings, bundles, crops | Cloudflare R2 (free, 10 GB) | ~105 MB of video and JPEGs, and R2 charges nothing for egress |
| The pipeline | the GPU box (Racer, 3090) | stages 1–15 are CUDA work |

**The pipeline never runs in a Worker.** Stage 8 alone is minutes of GPU time;
a Worker's CPU budget is milliseconds. The Worker serves what a run produced.

---

## Do we need a Cloudflare Tunnel for the GPU?

**No — and that is the better answer.**

A tunnel exists to give the outside world a way *in* to a machine that has no
public address. That is only needed if something must call the GPU box. In this
design nothing does: the GPU box **pulls** work.

```
GPU box                                     Cloudflare Worker
   |                                               |
   |--- POST /api/jobs/claim  (outbound) --------->|
   |<-- job + recording URL + claim token ---------|
   |                                               |
   |--- POST /api/jobs/:id/status (outbound) ----->|   progress, repeatedly
   |--- PUT  r2://drishti-runs/... (outbound) ---->|   artifacts
   |--- POST /api/jobs/:id/status complete ------->|
```

Every arrow is outbound HTTPS, which any NAT and any campus firewall already
allows. That means:

- no port forward, no static IP, no tunnel daemon to keep alive
- the box can move networks — hostel Wi-Fi, lab ethernet, a laptop hotspot —
  and nothing needs reconfiguring
- if the agent crashes or the box sleeps, jobs simply stay queued. Nothing is
  lost, and nothing is delivered into a void.

A push design would need the tunnel *and* would have to handle the box being
unreachable anyway. Pulling removes the failure mode instead of handling it.

**Use a tunnel only if you separately want** to reach the GPU box for something
else — an SSH shell from anywhere, a live RTSP preview, a Jupyter notebook. That
is a real convenience, and it is independent of this pipeline:

```bash
cloudflared tunnel login
cloudflared tunnel create racer
cloudflared tunnel route dns racer racer.yourdomain.com
cloudflared tunnel run --url http://localhost:8000 racer
```

Nothing in the console requires it.

---

## The flow, end to end

Every step below is exercised by a real request; none of it is aspirational.

```
operator uploads a recording
   PUT /api/uploads/:centreId/:filename        -> 201, streamed to storage
        |
        v
recording registered, marked "not run"          <- honest: no run exists yet
        |
   POST /api/videos/:id/process                 -> 202 Accepted, in ~40 ms
        |                                          (a job row, not a wait)
        v
job state: queued
        |
   GPU agent: POST /api/jobs/claim              -> job + claim token
        v
job state: claimed -> running                    stage + progress reported
        |
   pipeline stages 1..15 on the 3090
   bundles + overlay + review crops built
   artifacts uploaded to R2
        |
   POST /api/jobs/:id/status  state=complete    -> must name its run_key
        v
job state: complete, recording now points at the run
console reads /data/<run>.json, /crops/<run>/…
```

Two guard rails that matter:

- **A complete job must name the run it produced.** A job that finished with no
  run key would leave the console showing an empty dashboard, and an empty
  dashboard reads as *nothing was found* — a very different claim from *the
  pipeline died in stage 8*. That request is rejected.
- **A failure is recorded as a failure**, with the stage and the error text.
  The agent catches its own exceptions specifically so a crash cannot leave a
  job stuck in `claimed`, which looks identical to "still working".

---

## 1. Cloudflare (once)

```bash
cd console
npx wrangler login
```

Create the database and the bucket:

```bash
npx wrangler d1 create drishti
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`. Then:

```bash
npx wrangler d1 execute drishti --remote --file worker/schema.d1.sql
npx wrangler r2 bucket create drishti-runs
```

R2 needs a card on file even though this stays inside the free allowance.

Set the inference key as a secret, never a var — a var in `wrangler.toml` is a
credential in git:

```bash
npx wrangler secret put CEREBRAS_API_KEY
```

## 2. Build and deploy

```bash
npm run build          # dist/ is ~724 KB: app only, no run artifacts
npx wrangler deploy
```

`vite.config.ts` sets `copyPublicDir: false` deliberately. With the default,
`dist/` was **106 MB** — far past what Cloudflare accepts as Worker assets, and
worse, Workers Assets is consulted *before* the Worker runs, so `/media/...` was
answered from that copy instead of from R2 and the range-request handling never
executed. Video seeking silently degraded to whole-file downloads.

## 3. Push the run artifacts

```bash
node tools/upload-assets.mjs           # 2,076 files, ~100 MB
node tools/upload-assets.mjs --only 1512_12_paper   # or one run
```

Puts are idempotent, so re-running retries anything that failed. Failures are
printed by filename — a partial upload that reported success is how a console
ends up showing one broken image and nobody knows which.

## 4. Register the runs

```bash
node tools/register-runs.mjs --base https://drishti-console.<you>.workers.dev
```

Idempotent, and it targets whatever console you point it at.

---

## 5. The GPU box (Racer)

```bash
git clone <repo> && cd Project-Classroom
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install -r requirements.txt
```

Check CUDA is actually in use before trusting a run — the three silent
CPU-fallback traps in this project all report success while running on the CPU:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Then point the agent at the console and let it poll:

```bash
set DRISHTI_CONSOLE=https://drishti-console.<you>.workers.dev
set ROBOFLOW_API_KEY=<key>
set DRISHTI_R2_BUCKET=drishti-runs

python tools/gpu_agent.py --once      # take one job, watch it, then stop
python tools/gpu_agent.py             # leave it polling
```

Run `--once` first. It takes a single job and exits, so a wiring mistake shows
up on one recording instead of on the whole queue.

To keep it running after logout, install it as a service (Windows):

```bash
schtasks /create /tn DrishtiAgent /sc onstart /ru SYSTEM ^
  /tr "C:\path\.venv\Scripts\python.exe C:\path\tools\gpu_agent.py"
```

---

## Running it self-hosted instead

One process serves the console, the API and the media. No Cloudflare involved.

```bash
cd console
npm install
npm run build
npm start                 # http://localhost:5179
```

SQLite by default; set `DATABASE_URL` to use Postgres instead. The server prints
the database path it opened on startup — a mistyped `DRISHTI_DB` otherwise opens
a different, empty database, and the console then shows an empty project list
that is indistinguishable from "nobody has created anything yet".

Development, with hot reload:

```bash
npm run dev               # API on 5179, Vite on 5178 proxying /api
```

---

## What is not done

- **Artifact upload from the agent to R2 uses `wrangler`**, so the GPU box needs
  wrangler authenticated. An S3-API credential would be better and is a small
  change to `tools/upload-assets.mjs`.
- **No authentication on the console.** Anyone who can reach the URL can review
  and can queue jobs. Cloudflare Access in front of it is the cheapest fix and
  needs no code.
- **`/api/jobs/claim` is unauthenticated.** On a public deployment that lets a
  stranger drain the queue. It needs a shared agent token before this is exposed.
- **No job timeout.** An agent that dies mid-run leaves the job `claimed`
  forever; nothing currently reclaims it.
- **Postgres is provisioned but unused** — a Supabase project (`drishti-console`,
  ap-south-1) was created while evaluating hosts, with the same schema and an
  append-only trigger on `decisions`. D1 is the better fit here. Delete the
  Supabase project if you do not want it.
