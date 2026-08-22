import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bundle } from "./types";
import type { CropManifest, Decision } from "./review";
import { PROJECTS, findVideo, firstProcessed } from "./projects";
import { Dashboard } from "./screens/Dashboard";
import { ReviewScreen } from "./screens/ReviewScreen";
import { VideoScreen } from "./screens/VideoScreen";
import "./App.css";

type Screen = "dashboard" | "review" | "video";

const SCREENS: { id: Screen; label: string }[] = [
  { id: "dashboard", label: "Overview" },
  { id: "review", label: "Review" },
  { id: "video", label: "Video" },
];

export default function App() {
  const start = firstProcessed(PROJECTS);
  const [videoId, setVideoId] = useState(start?.video.id ?? "");
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [crops, setCrops] = useState<CropManifest>({});
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [openCentre, setOpenCentre] = useState<string | null>(
    start?.centre.id ?? null,
  );

  const found = useMemo(() => findVideo(PROJECTS, videoId), [videoId]);
  const video = found?.video;

  useEffect(() => {
    if (!video?.bundle) {
      setBundle(null);
      setCrops({});
      return;
    }
    let live = true;
    setError(null);
    Promise.all([
      fetch(video.bundle).then((r) => {
        if (!r.ok) throw new Error(`bundle ${r.status}`);
        return r.json();
      }),
      video.crops
        ? fetch(`${video.crops}/manifest.json`)
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({}))
        : Promise.resolve({}),
    ])
      .then(([b, c]) => {
        if (!live) return;
        setBundle(b);
        setCrops(c);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [video]);

  const decide = useCallback((trackId: number, decision: Decision) => {
    // Append-only in spirit: a later decision replaces the shown state, but
    // the store keeps one entry per person and the server will keep the full
    // history once decisions are persisted.
    setDecisions((d) => ({ ...d, [trackId]: decision }));
  }, []);

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail__brand">
          <span className="rail__mark" aria-hidden="true" />
          <b>Drishti</b>
        </div>

        {PROJECTS.map((project) => (
          <div key={project.id} className="rail__project">
            <p className="rail__ptitle">{project.name}</p>
            {project.centres.map((centre) => {
              const open = openCentre === centre.id;
              return (
                <div key={centre.id}>
                  <button
                    className="rail__centre"
                    aria-expanded={open}
                    onClick={() => setOpenCentre(open ? null : centre.id)}
                  >
                    <span>{centre.name}</span>
                    <b className="mono">{centre.videos.length}</b>
                  </button>
                  {open && (
                    <ul className="rail__videos">
                      {centre.videos.map((v) => (
                        <li key={v.id}>
                          <button
                            className={v.id === videoId ? "is-on" : ""}
                            disabled={!v.processed}
                            title={
                              v.processed
                                ? v.name
                                : `${v.name} — not processed yet`
                            }
                            onClick={() => {
                              setVideoId(v.id);
                              setScreen("dashboard");
                            }}
                          >
                            <span>{v.name}</span>
                            {!v.processed && <em>not run</em>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <button className="rail__new" type="button" disabled>
          + New project
        </button>
      </nav>

      <div className="shell">
        <header className="top">
          <div className="top__where">
            <span className="mono">
              {found?.project.name} / {found?.centre.name}
            </span>
            <h1>{video?.name ?? "No recording selected"}</h1>
          </div>
          <nav className="top__tabs">
            {SCREENS.map((s) => (
              <button
                key={s.id}
                className={screen === s.id ? "is-on" : ""}
                onClick={() => setScreen(s.id)}
                disabled={!bundle}
              >
                {s.label}
              </button>
            ))}
          </nav>
        </header>

        <main className="main">
          {error && <p className="state state--err">{error}</p>}

          {!video?.processed && (
            <p className="state">
              This recording has not been processed yet. Run the pipeline on it
              to see findings — an empty dashboard would read like
              &ldquo;nothing was found&rdquo;, which is not the same thing.
            </p>
          )}

          {video?.processed && !bundle && !error && (
            <p className="state mono">Loading run…</p>
          )}

          {bundle && screen === "dashboard" && (
            <Dashboard
              bundle={bundle}
              crops={crops}
              video={video!}
              decisions={decisions}
              onReview={() => setScreen("review")}
            />
          )}

          {bundle && screen === "review" && (
            <ReviewScreen
              bundle={bundle}
              crops={crops}
              cropBase={video!.crops ?? ""}
              decisions={decisions}
              onDecide={decide}
            />
          )}

          {bundle && screen === "video" && (
            <VideoScreen
              bundle={bundle}
              videoSrc={video!.video ?? ""}
              overlaySrc={video!.overlay ?? ""}
            />
          )}
        </main>
      </div>
    </div>
  );
}
