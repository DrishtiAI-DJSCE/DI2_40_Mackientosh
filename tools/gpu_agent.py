"""Run pipeline jobs on the GPU box, pulling work from the console.

This is the process that turns "somebody uploaded a recording" into "a run
exists". It runs on the machine with the 3090 and needs **no inbound
connectivity**: it polls the console for work, so there is no port to forward,
no public IP to arrange and no tunnel to keep alive. A box behind a college NAT
can run this unchanged.

The loop, once per job:

    claim  -> download the recording -> run the pipeline stages
           -> build the console bundles and review crops
           -> upload the artifacts -> report complete

Progress is reported as it goes, so the console can show which stage is
executing rather than a spinner. Every report carries the claim token issued at
claim time; an agent whose job was reassigned cannot overwrite the new
holder's status.

A failure is reported as a failure, with the stage and the error text. It is
never reported as a completed run with no findings -- an empty dashboard reads
as "nothing was found", which is a very different statement from "the pipeline
died in stage 8".

Usage on the GPU box:

    set DRISHTI_CONSOLE=https://console.example.workers.dev
    set ROBOFLOW_API_KEY=...
    python tools/gpu_agent.py --once        # take one job and stop
    python tools/gpu_agent.py               # poll forever
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# The stages this agent runs, in order, with the share of the progress bar each
# one gets. The weights are rough wall-clock proportions from the 1512 run --
# pose and object detection dominate, and a bar that moved linearly across
# stages would sit at 40% for most of the job.
STAGES: list[tuple[str, float]] = [
    ("01_ingest", 0.04),
    ("07_tracking", 0.10),
    ("08_pose", 0.34),
    ("09_object", 0.22),
    ("14_person_timeline", 0.14),
    ("14b_chit", 0.05),
    ("14c_gates", 0.02),
    ("14d_sam3", 0.05),
    ("15_evidence", 0.04),
]


class Console:
    """The console's job API, over plain HTTP."""

    def __init__(self, base: str, agent: str):
        self.base = base.rstrip("/")
        self.agent = agent
        self.token: str | None = None

    def _call(self, path: str, body: dict | None = None, method="POST"):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())

    def claim(self) -> tuple[dict, dict] | None:
        doc = self._call("/api/jobs/claim", {"agent": self.agent})
        if not doc.get("job"):
            return None
        self.token = doc["claim_token"]
        return doc["job"], doc["video"]

    def report(self, job_id, state="running", stage=None, progress=None,
               run_key=None, error=None):
        return self._call(
            f"/api/jobs/{job_id}/status",
            {
                "claim_token": self.token,
                "state": state,
                "stage": stage,
                "progress": progress,
                "run_key": run_key,
                "error": error,
            },
        )

    def download(self, media_url: str, target: Path) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        url = media_url if media_url.startswith("http") else f"{self.base}{media_url}"
        with urllib.request.urlopen(url, timeout=600) as res, \
                target.open("wb") as out:
            shutil.copyfileobj(res, out, length=1 << 20)
        if not target.stat().st_size:
            raise RuntimeError(f"downloaded 0 bytes from {url}")
        return target


def run_stage(cmd: list[str], stage: str) -> None:
    """Run one stage, and fail loudly if it fails.

    `check=True` matters: a stage that exits non-zero has not produced the
    artifacts the next stage reads, and continuing would eventually surface as
    an empty result rather than as the error it is.
    """
    print(f"  $ {' '.join(str(c) for c in cmd)}", flush=True)
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-25:]
        raise RuntimeError(f"{stage} exited {proc.returncode}:\n" + "\n".join(tail))


def process(console: Console, job: dict, video: dict, *, keep: bool) -> str:
    """Take one job from claimed to a finished run key."""
    job_id = job["id"]
    run_key = f"job{job_id}"
    run_dir = REPO / "artifacts" / "runs" / f"job{job_id}" / "video"

    source = console.download(
        video["media_url"],
        REPO / "artifacts" / "incoming" / f"job{job_id}{Path(video['media_url']).suffix}",
    )
    print(f"  downloaded {source} ({source.stat().st_size / 1e6:.1f} MB)", flush=True)

    done = 0.0
    for stage, weight in STAGES:
        console.report(job_id, "running", stage=stage, progress=round(done, 3))
        print(f"[{done:5.0%}] {stage}", flush=True)

        # The pipeline is driven through its own runner so this agent does not
        # duplicate stage wiring; see pipeline/ for what each stage does.
        run_stage(
            [sys.executable, "-m", "pipeline.run",
             "--stage", stage, "--run", str(run_dir), "--video", str(source)],
            stage,
        )
        done += weight

    # The console reads three derived artifacts, not the run directory itself.
    console.report(job_id, "running", stage="bundling", progress=0.96)
    out = REPO / "console" / "public"
    run_stage([sys.executable, "tools/build_console_bundle.py",
               "--run", str(run_dir), "--out", str(out / "data" / f"{run_key}.json")],
              "bundle")
    run_stage([sys.executable, "tools/build_overlay_bundle.py",
               "--run", str(run_dir),
               "--out", str(out / "data" / f"{run_key}.overlay.json")],
              "overlay")
    run_stage([sys.executable, "tools/build_review_crops.py",
               "--run", str(run_dir), "--video", str(source),
               "--out", str(out / "crops" / run_key)],
              "crops")

    console.report(job_id, "running", stage="uploading", progress=0.99)
    uploader = REPO / "console" / "tools" / "upload-assets.mjs"
    if os.environ.get("DRISHTI_R2_BUCKET") and uploader.exists():
        run_stage(["node", str(uploader), "--only", run_key,
                   "--bucket", os.environ["DRISHTI_R2_BUCKET"]], "upload")

    if not keep:
        source.unlink(missing_ok=True)
    return run_key


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--console", default=os.environ.get("DRISHTI_CONSOLE",
                                                        "http://localhost:5179"))
    ap.add_argument("--agent", default=f"{platform.node()}/gpu")
    ap.add_argument("--once", action="store_true",
                    help="take at most one job, then exit")
    ap.add_argument("--poll", type=float, default=10.0,
                    help="seconds between polls when there is no work")
    ap.add_argument("--keep-source", action="store_true",
                    help="do not delete the downloaded recording afterwards")
    args = ap.parse_args()

    console = Console(args.console, args.agent)
    print(f"agent {args.agent} -> {console.base}", flush=True)

    while True:
        try:
            claimed = console.claim()
        except urllib.error.URLError as e:
            # The console being unreachable is not a job failure. Keep polling:
            # a restarting server or a dropped link must not consume the queue.
            print(f"  console unreachable ({e}); retrying", flush=True)
            time.sleep(args.poll)
            continue

        if not claimed:
            if args.once:
                print("no queued jobs", flush=True)
                return 0
            time.sleep(args.poll)
            continue

        job, video = claimed
        print(f"claimed job {job['id']} for {video['name']}", flush=True)
        try:
            run_key = process(console, job, video, keep=args.keep_source)
            console.report(job["id"], "complete", stage="done", progress=1.0,
                           run_key=run_key)
            print(f"job {job['id']} complete -> {run_key}", flush=True)
        except Exception as exc:  # noqa: BLE001 - the agent must never die here
            # Report it. A crashed agent that says nothing leaves the job
            # 'claimed' forever, which looks identical to "still working".
            print(f"job {job['id']} FAILED: {exc}", flush=True)
            try:
                console.report(job["id"], "failed", error=str(exc)[:2000])
            except Exception as report_error:  # noqa: BLE001
                print(f"  could not report failure: {report_error}", flush=True)

        if args.once:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
