# Project Classroom — Product Zero

Offline analysis of a complete examination-hall CCTV recording into an auditable
timeline of seat-linked motion, pose and object evidence, for **human review**.

It is not a cheating classifier. It does not infer intent, issue verdicts, or use
face, name or biometric identity. Its vocabulary is observational throughout:
`phone-like object detected`, `hand entered lap zone`, `ambiguous_seat`,
`insufficient_visual_evidence`.

Product Zero is **inference and measurement only**. Training and fine-tuning are
deferred until this pipeline reports its error clusters and source limitations.

## The one command

```bash
python tools/run_product_zero.py \
    --calibration calib/cam12_e1_v1.json \
    --dfine models/dfine/onnx/model.onnx \
    --pose \
    "C:/DrishtiAI/03.CCTV Mobile Usage.mkv"
```

That runs every stage in the order PRD §4 mandates and writes one immutable run
folder under `artifacts/runs/<run_id>/`. Add `--gemma-url` for the VLM review,
`--reference refs/<file>.jsonl` for stage-12 evaluation, and `--seal` to make
the run folder immutable when it finishes.

Nothing above is required. With no models at all the run still completes and the
run folder records exactly which configurations were unavailable and why — a
configuration that cannot load is **never** silently substituted.

## What comes out

```text
artifacts/runs/<run_id>/
├── RUN_MANIFEST.json          what the run was: hashes, versions, licences
├── RUN_STATUS.json            what it did: per-stage state and coverage
├── 05_motion_roi/             window metrics, baselines, gate log, candidates
├── 06_segmentation/           events and every state transition with its reason
├── 07_tracking/<config>/      three tracker configurations, side by side
├── 08_pose/<config>/          pose A/B on a hashed, identical manifest
├── 09_object/<config>/        detector and SAHI A/B on identical crops
├── 10_evidence/               temporal confirmation, packets, ranked events
├── 11_gemma/<event_id>/       contact sheet, prompt, raw output, validation
├── 12_evaluation/             matches, misses, false positives, gate audit
└── 13_reports/                final report, model selection, quality limits
```

## The output contract

Read [`docs/OUTPUT_CONTRACT.md`](docs/OUTPUT_CONTRACT.md) before changing what
this system says. It is frozen at **v1.0.0** and it specifies the whole output
surface: one immutable evidence record per proposal, a closed vocabulary of 36
reason codes, and a six-state policy machine of which automated code may write
only four.

```bash
python tools/build_evidence_records.py --run artifacts/runs/1505/03_mobile
```

Across the four completed runs that produces **63,138 evidence records over
1,010 tracks, of which 4 are `review_candidate`** — 12_paper tracks 118 and 53
(the man who took the paper), 03_mobile track 1 (the phone), and 04_talking
track 4. 964 tracks are `needs_better_view`, and that number is the honest
headline rather than something to bury.

No component in this system is a judge. `human_confirmed` and `human_dismissed`
are the only states that assert a policy violation, and
`fusion.assert_machine_state()` raises if automated code tries to write either.

## The design in five rules

**Full video first, references last.** Motion scans every decodable window at
54–111× realtime using codec motion vectors. The reference manifest is readable
only at stage 12, and `tools/evaluate_run.py` refuses to evaluate at all if any
earlier stage's artifacts carry reference annotations.

**Gates route evidence; they do not erase it.** Five states —
`pass`, `deprioritise`, `uncertain`, `suppress_from_auto_ranking`, `failed` —
each recorded with its inputs, thresholds, and a reason in words. Nothing is
discarded. Suppressed evidence stays searchable; failed evidence is a hole with
a reason, never an interpolation.

**No model is truth.** Every A/B is run on byte-identical, hashed manifest rows,
and each configuration records the digest of the rows it was actually handed. A
comparison whose digests differ is reported as `VIOLATED` and no selection may be
made from it. No configuration is called best until every runnable one has a
matched report — and selection happens at stage 12, against references.

**Seat is context, not identity.** Attribution scores a person box's lower
footprint against calibrated seat polygons, never the box centre. Where the
margin is thin or the operator declared the boundary unresolvable, the answer is
`ambiguous_seat` with every candidate score retained.

**Abstention is an output.** A crop below the source-resolution floor produces
`insufficient_visual_evidence` as a row, before any model sees it. Magnification
is interpolation, not detail, and every crop records its native footprint.

## Setup

```bash
python -m pip install -r requirements-rtx3090.lock
```

The lock file records a **CPU** torch build — every measurement in this
repository was taken on CPU, and the run manifest records the device for each
configuration so a CPU figure is never compared against a GPU one. On an RTX
3090, replace the torch line with the CUDA build matching your driver.

Check what will actually run before committing to a full pass:

```bash
python tools/preflight_rtx3090.py --experiment configs/experiments/product_zero.yaml --sources "path/to/video.mkv"
```

Preflight tests **launchability**, not just that a weight file exists, and
records licence status for each configuration.

### Roboflow-hosted models (optional)

Two stages call hosted Roboflow endpoints. Both are optional — the pipeline
runs without them — and both need one key, read from the environment and never
from a tracked file. Get one at <https://app.roboflow.com/settings/api>.

```bash
export ROBOFLOW_API_KEY=your_key_here
```

| Stage | Model | What it adds |
|---|---|---|
| `tools/attach_chit_detections.py` | `chit-paper-new/2` (CC BY 4.0) | Paper detection at the hands, attached to an existing run |
| `tools/adjudicate_with_sam3.py` | workflow `kawaljeets-workspace/general-segmentation-api-6` (SAM 3) | Text-promptable segmentation used to confirm or reject those detections |

```bash
python tools/attach_chit_detections.py VIDEO --run artifacts/runs/1501/12_paper
python tools/score_chit_evidence.py --run artifacts/runs/1501/12_paper
python tools/adjudicate_with_sam3.py VIDEO --run artifacts/runs/1501/12_paper
```

`inference-sdk` is Roboflow's documented client but declares
`Requires-Python >=3.10,<3.13`; this project runs 3.13, so both stages call the
REST endpoints with `requests`. Keep concurrency modest — a 16-worker burst lost
85% of calls to rate limiting; the tools default to 6.

**These are network calls**, which conflicts with the offline requirement in
PS 2. They are usable for development and for building a labelled set; a
submission needs local weights.

## Tests

```bash
for t in tests/test_*.py; do python "$t"; done
```

45 offline gates, none of which need a model or a video. The Roboflow tests
add a live check that is **skipped unless `ROBOFLOW_API_KEY` is set**, so the
suite stays offline by default. Each one is a defect
this project actually hit, kept as a permanent regression test — the empty
desk row that outscored an occupied seat, the spike promoted to a two-second
event, the verifier that described the wrong person at confidence 1.0, the
identity checker that fired on the word "the".

## Current state

| Phase | Status |
|---|---|
| 0 — preflight, run manifest, artifacts, config validation | complete |
| 1 — ingest, PTS truth, ten health conditions | complete |
| 2 — calibration approval, camera epochs, quality-gated alignment | complete |
| 3 — motion, ROI, baselines, segmentation, gates | complete |
| 4 — tracking and pose A/B | complete |
| 5 — crops, detector and SAHI A/B, temporal confirmation | complete |
| 6 — evidence packets, bounded Gemma review, ranking | complete |
| 7 — reference evaluation and gate audit | complete |

**What cannot be claimed from this corpus today**, and why, is recorded in
`doubt.md` and in every run's `13_reports/quality_limitations.md`:

- No accuracy, precision, recall or false-positives-per-hour figure, because no
  real reference manifest exists yet. The manifest under `refs/` is a
  demonstration file with invented timestamps, used to exercise stage 12.
- No claim about 30–60 person halls. The validated corpus is 1–17 people; the
  larger figure is a capacity and design target.
- No long-recording or events-per-hour claim. The corpus is short pre-cut clips,
  processed end to end.
- No chit claim of any kind. The stock COCO head has no `secondary_paper_chit`
  class, so chit recall here is structurally zero.

The measured finding worth carrying forward: on 42 identical crop rows, SAHI
produced **69% more detections and zero additional phones** at 4.5× the cost —
the increase was entirely hard negatives and `unknown_object`. PRD §19
anticipated this; slicing magnifies a region into the detector's input but
cannot restore detail the source never captured.
