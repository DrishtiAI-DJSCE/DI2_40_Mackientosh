import { useEffect, useMemo, useState } from "react";
import type { Bundle, State, Track } from "./types";
import { STATE_ORDER } from "./types";
import { EvidenceCard } from "./components/EvidenceCard";
import { StateChip } from "./components/StateChip";
import { VideoScreen } from "./screens/VideoScreen";
import { STATE_LABEL, withDenominator } from "./lib/format";
import "./App.css";

const MEDIA = {
  bundle: "/data/1512_12_paper.json",
  overlay: "/data/1512_12_paper.overlay.json",
  video: "/media/1512_12_paper.mp4",
};

/** Sort options. Detection count is deliberately absent -- ranking by it
 *  ranks the busiest tracker, which the output contract forbids. */
const SORTS = {
  priority: { label: "Priority", of: (t: Track) => t.priority ?? 0 },
  longest_episode: {
    label: "Longest episode",
    of: (t: Track) =>
      t.episodes.reduce((b, e) => Math.max(b, e.to_ms - e.from_ms), 0),
  },
  total_handling: {
    label: "Total handling",
    of: (t: Track) =>
      t.episodes.reduce((b, e) => b + (e.to_ms - e.from_ms), 0),
  },
  modalities: { label: "Modalities", of: (t: Track) => t.modalities.length },
  coverage: {
    label: "Coverage",
    of: (t: Track) => t.coverage_of_recording ?? 0,
  },
  first_seen: {
    label: "Chronological",
    of: (t: Track) => -(t.first_seen_ms ?? 0),
  },
} as const;

type SortKey = keyof typeof SORTS;

export default function App() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State | "all">("review_candidate");
  const [sort, setSort] = useState<SortKey>("priority");
  const [screen, setScreen] = useState<"queue" | "video">("queue");

  useEffect(() => {
    fetch(MEDIA.bundle)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(setBundle)
      .catch((e) => setError(String(e)));
  }, []);

  const visible = useMemo(() => {
    if (!bundle) return [];
    const rows =
      state === "all"
        ? bundle.tracks
        : bundle.tracks.filter((t) => t.state === state);
    const of = SORTS[sort].of;
    return [...rows].sort((a, b) => of(b) - of(a));
  }, [bundle, state, sort]);

  if (error) {
    return (
      <div className="boot boot--error">
        <h1>Could not load the run bundle</h1>
        <p className="mono">{error}</p>
        <p>
          Build one with <code>tools/build_console_bundle.py</code>.
        </p>
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="boot">
        <p className="mono">Loading run bundle…</p>
      </div>
    );
  }

  const counts = bundle.counts.states;
  const abstain = counts.needs_better_view ?? 0;
  const abstainStat = withDenominator(abstain, bundle.counts.tracks);

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail__brand">
          <b>Drishti</b>
          <span className="mono">{bundle.run.run_id ?? "run"}</span>
        </div>

        <p className="rail__group">Findings</p>
        <ul className="rail__nav">
          <li>
            <button
              className={screen === "queue" && state === "all" ? "is-on" : ""}
              onClick={() => {
                setScreen("queue");
                setState("all");
              }}
            >
              All people <b className="mono">{bundle.counts.tracks}</b>
            </button>
          </li>
          {STATE_ORDER.filter((s) => counts[s] !== undefined).map((s) => (
            <li key={s}>
              <button
                className={screen === "queue" && state === s ? "is-on" : ""}
                onClick={() => {
                  setScreen("queue");
                  setState(s);
                }}
              >
                {STATE_LABEL[s]} <b className="mono">{counts[s]}</b>
              </button>
            </li>
          ))}
        </ul>

        <p className="rail__group">Explore</p>
        <ul className="rail__nav">
          <li>
            <button
              className={screen === "video" ? "is-on" : ""}
              onClick={() => setScreen("video")}
            >
              Video
            </button>
          </li>
        </ul>

        <p className="rail__group">Run</p>
        <dl className="rail__facts mono">
          <div>
            <dt>video</dt>
            <dd title={bundle.video}>{bundle.video}</dd>
          </div>
          <div>
            <dt>duration</dt>
            <dd>{(bundle.duration_ms / 1000).toFixed(1)}s</dd>
          </div>
          <div>
            <dt>revision</dt>
            <dd>
              {(bundle.run.code_revision ?? "—").slice(0, 7)}
              {bundle.run.code_dirty && <em> dirty</em>}
            </dd>
          </div>
        </dl>
      </nav>

      <main className={`main ${screen === "video" ? "main--wide" : ""}`}>
        <header className="head">
          <div>
            <h1>
              {screen === "video"
                ? "Video"
                : (STATE_LABEL[state as State] ?? "All people")}
            </h1>
            <p className="head__sub">
              {screen === "video"
                ? "Drag the handle to reveal what the system marked"
                : `${visible.length} of ${bundle.counts.tracks} tracks`}
            </p>
          </div>
          {screen === "queue" && (
            <label className="sort mono">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                {Object.entries(SORTS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>

        {screen === "video" && (
          <div className="screen">
            <VideoScreen
              bundle={bundle}
              videoSrc={MEDIA.video}
              overlaySrc={MEDIA.overlay}
            />
          </div>
        )}

        {screen === "queue" && (
          <>
            {/* Abstention is structural, not a filter someone has to find. */}
            <section className="abstain">
              <StateChip state="needs_better_view" size="sm" />
              <p>
                The system declined to judge <b>{abstainStat.text}</b> of the
                people it observed. That is the honest headline for this run,
                not something to read past.
              </p>
            </section>

            {visible.length === 0 ? (
              <p className="empty">
                No tracks in this state. That is a measurement, not an
                all-clear.
              </p>
            ) : (
              <div className="queue">
                {visible.map((t) => (
                  <EvidenceCard
                    key={t.track_id}
                    track={t}
                    duration_ms={bundle.duration_ms}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <footer className="foot">
          <p>
            Every number here is copied from the run artifacts, never
            recomputed. No accuracy figure exists for this system until the
            evaluation pack in OUTPUT_CONTRACT §9 is built.
          </p>
        </footer>
      </main>
    </div>
  );
}
