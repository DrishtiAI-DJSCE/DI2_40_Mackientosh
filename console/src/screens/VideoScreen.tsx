import { useEffect, useMemo, useState } from "react";
import type { Bundle, Track } from "../types";
import type { OverlayBundle } from "../overlay";
import {
  WipePlayer,
  DEFAULT_LAYERS,
  LAYER_LABEL,
  type Layers,
} from "../components/WipePlayer";
import { FlagTimeline } from "../components/FlagTimeline";
import { StateChip } from "../components/StateChip";
import { subjectName, timecode } from "../lib/format";
import "./VideoScreen.css";

/** Video geometry is in source pixels. The bundle does not carry the frame
 *  size, so it is stated here alongside the media it belongs to. */
const SOURCE = { width: 1280, height: 720 };

export function VideoScreen({
  bundle,
  videoSrc,
  overlaySrc,
}: {
  bundle: Bundle;
  videoSrc: string;
  overlaySrc: string;
}) {
  const [overlay, setOverlay] = useState<OverlayBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [focus, setFocus] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [seek, setSeek] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetch(overlaySrc)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((doc) => {
        if (live) setOverlay({ ...doc, ...SOURCE });
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [overlaySrc]);

  // Everyone who produced a mark, most notable first. The focus list is not
  // the review queue -- a reviewer watching the tape needs to isolate any
  // track, including the ones the system said nothing about.
  const people: Track[] = useMemo(
    () =>
      [...bundle.tracks].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
      ),
    [bundle.tracks],
  );

  const focused = focus === null ? null : people.find((t) => t.track_id === focus);

  return (
    <div className="video">
      <div className="video__main">
        {error ? (
          <p className="video__error">
            Overlay bundle failed to load: <span className="mono">{error}</span>
          </p>
        ) : (
          <WipePlayer
            videoSrc={videoSrc}
            overlay={overlay}
            layers={layers}
            focusTrack={focus}
            onTimeUpdate={setNowMs}
            seekToMs={seek}
          />
        )}

        <div className="video__layers">
          <span className="video__legend mono">Layers</span>
          {(Object.keys(LAYER_LABEL) as (keyof Layers)[]).map((key) => (
            <button
              key={key}
              type="button"
              className={layers[key] ? "is-on" : ""}
              aria-pressed={layers[key]}
              onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
            >
              {LAYER_LABEL[key]}
            </button>
          ))}
        </div>

        {!overlay && !error && (
          <p className="video__loading mono">Loading overlay geometry…</p>
        )}

        {focused && (
          <section className="video__focus">
            <header>
              <h3>
                {subjectName(
                  focused.track_id,
                  focused.seat,
                  focused.seat_state,
                ).name}
              </h3>
              <StateChip state={focused.state} size="sm" />
              <span className="mono">{timecode(nowMs)}</span>
            </header>
            <FlagTimeline
              track={focused}
              duration_ms={bundle.duration_ms}
              playheadMs={nowMs}
              onSeek={setSeek}
            />
          </section>
        )}
      </div>

      <aside className="video__aside">
        <p className="video__legend mono">Isolate a person</p>
        <button
          type="button"
          className={focus === null ? "is-on" : ""}
          onClick={() => setFocus(null)}
        >
          Everyone
        </button>
        <ul>
          {people.map((t) => (
            <li key={t.track_id}>
              <button
                type="button"
                className={focus === t.track_id ? "is-on" : ""}
                onClick={() => {
                  setFocus(t.track_id);
                  if (t.first_seen_ms !== null) setSeek(t.first_seen_ms);
                }}
              >
                <span>#{t.track_id}</span>
                <StateChip state={t.state} size="sm" />
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
