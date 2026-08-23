import { useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, Track } from "../types";
import type { CropManifest, Decision } from "../review";
import type { OverlayBundle } from "../overlay";
import {
  WipePlayer,
  DEFAULT_LAYERS,
  LAYER_LABEL,
  type Layers,
} from "../components/WipePlayer";
import { StateChip } from "../components/StateChip";
import { subjectName, timecode } from "../lib/format";
import { flagLabel } from "../lib/humanize";
import "./VideoScreen.css";

/** Overlay geometry is in source pixels, and the bundle now carries the frame
 *  it was measured against. This used to be hard-coded to 1280x720 next to the
 *  media -- correct for most of the corpus and wrong for the 640x480 recording,
 *  where every box landed at half scale in the top-left quadrant. A bundle
 *  without the size is refused rather than guessed at. */
const FALLBACK = { width: 1280, height: 720 };

interface Mark {
  from_ms: number;
  to_ms: number;
  track_id: number;
  detail: string;
}

interface Kind {
  id: string;
  label: string;
  color: string;
  people: number;
  marks: Mark[];
  /** On unless the reviewer says otherwise. */
  defaultOn: boolean;
  note: string;
}

/**
 * Where each kind of finding actually lands in time.
 *
 * Object evidence has real extents (the episodes), and so do absences and
 * orientation events. Most flags do not -- they are statements about a whole
 * track -- and those are drawn across the span the person was actually on
 * camera rather than the whole recording. Claiming a flag covers time the
 * person was never visible would be a lie of extent.
 */
function buildKinds(
  tracks: Track[],
  crops: CropManifest,
  duration: number,
): Kind[] {
  const kinds = new Map<string, Kind>();
  const add = (
    id: string,
    label: string,
    color: string,
    defaultOn: boolean,
    note: string,
  ) => {
    if (!kinds.has(id)) {
      kinds.set(id, {
        id,
        label,
        color,
        people: 0,
        marks: [],
        defaultOn,
        note,
      });
    }
    return kinds.get(id)!;
  };

  for (const t of tracks) {
    const crop = crops[String(t.track_id)];
    const from = t.first_seen_ms ?? 0;
    const to = t.last_seen_ms ?? duration;

    // The one lane that is a positive result rather than a proposal: the
    // referee looked at this crop and named the object. Marked by default,
    // because it is the finding a reviewer came here for.
    if (crop?.key_supported) {
      const k = add(
        "confirmed",
        "Confirmed by the second model",
        "var(--s-confirm)",
        true,
        "SAM 3 looked at this crop and named the object.",
      );
      k.people += 1;
      k.marks.push({
        from_ms: crop.key_pts_ms,
        to_ms: crop.key_pts_ms + 400,
        track_id: t.track_id,
        detail: `#${t.track_id} · ${timecode(crop.key_pts_ms)}`,
      });
    }

    if (t.state === "review_candidate") {
      const k = add(
        "review",
        "Sent for review",
        "var(--s-review)",
        true,
        "The machine routed this person to a human. It is not a verdict.",
      );
      k.people += 1;
      const spans = t.episodes.length ? t.episodes : [{ from_ms: from, to_ms: to }];
      for (const s of spans) {
        k.marks.push({
          from_ms: s.from_ms,
          to_ms: s.to_ms,
          track_id: t.track_id,
          detail: `#${t.track_id} · ${timecode(s.from_ms)}–${timecode(s.to_ms)}`,
        });
      }
    }

    for (const flag of t.flags) {
      const k = add(
        `flag:${flag.flag}`,
        flagLabel(flag.flag),
        `var(--lane-${flag.lane})`,
        flag.severity === "high",
        flag.why || flag.evidence,
      );
      k.people += 1;

      const spans =
        flag.lane === "object" && t.episodes.length
          ? t.episodes
          : flag.lane === "orientation" && t.orientation_events.length
            ? t.orientation_events
            : flag.lane === "presence" && t.absences.length
              ? t.absences
              : [{ from_ms: from, to_ms: to }];

      for (const s of spans) {
        k.marks.push({
          from_ms: s.from_ms,
          to_ms: s.to_ms,
          track_id: t.track_id,
          detail: `#${t.track_id} · ${flag.evidence}`,
        });
      }
    }
  }

  return [...kinds.values()].sort((a, b) => {
    if (a.defaultOn !== b.defaultOn) return a.defaultOn ? -1 : 1;
    return b.people - a.people;
  });
}

export function VideoScreen({
  bundle,
  crops,
  videoSrc,
  overlaySrc,
  decisions,
}: {
  bundle: Bundle;
  crops: CropManifest;
  videoSrc: string;
  overlaySrc: string;
  decisions: Record<number, Decision>;
}) {
  const [overlay, setOverlay] = useState<OverlayBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [focus, setFocus] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [seek, setSeek] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string> | null>(null);

  useEffect(() => {
    let live = true;
    fetch(overlaySrc)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((doc) => {
        if (!live) return;
        if (!doc.width || !doc.height) {
          // An older bundle, built before the size was recorded. Say so
          // instead of drawing boxes that may be in the wrong place.
          setError(
            "This overlay was built before frame size was recorded. Rebuild it " +
              "with tools/build_overlay_bundle.py — drawing it against an " +
              "assumed size would put the boxes in the wrong place.",
          );
          setOverlay({ ...doc, ...FALLBACK });
          return;
        }
        setOverlay(doc as OverlayBundle);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [overlaySrc]);

  // A person a reviewer said was not a violation is gone from here. Leaving
  // an overturned detection on the timeline would ask the same question twice
  // and quietly disagree with the answer.
  const live = useMemo(
    () =>
      bundle.tracks.filter(
        (t) => decisions[t.track_id] !== "human_dismissed",
      ),
    [bundle.tracks, decisions],
  );

  const kinds = useMemo(
    () => buildKinds(live, crops, bundle.duration_ms),
    [live, crops, bundle.duration_ms],
  );

  const on = useMemo(
    () => chosen ?? new Set(kinds.filter((k) => k.defaultOn).map((k) => k.id)),
    [chosen, kinds],
  );

  const toggle = (id: string) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const shown = kinds.filter((k) => on.has(k.id));

  const people: Track[] = useMemo(
    () => [...live].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    [live],
  );

  const focused = focus === null ? null : people.find((t) => t.track_id === focus);
  const dismissedCount = Object.values(decisions).filter(
    (d) => d === "human_dismissed",
  ).length;

  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const away = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [pickerOpen]);

  const pct = (ms: number) =>
    bundle.duration_ms > 0
      ? Math.max(0, Math.min(100, (ms / bundle.duration_ms) * 100))
      : 0;

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
            below={
              <div className="ribbon">
                <div
                  className="ribbon__band"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setSeek(
                      ((e.clientX - r.left) / r.width) * bundle.duration_ms,
                    );
                  }}
                >
                  {shown.length === 0 && (
                    <span className="ribbon__none mono">
                      nothing selected — pick findings on the right
                    </span>
                  )}
                  {shown.map((k) =>
                    k.marks
                      .filter(
                        (m) => focus === null || m.track_id === focus,
                      )
                      .map((m, i) => {
                        const left = pct(m.from_ms);
                        return (
                          <i
                            key={`${k.id}-${i}`}
                            style={{
                              left: `${left}%`,
                              width: `${Math.max(pct(m.to_ms) - left, 0.35)}%`,
                              background: k.color,
                            }}
                            title={`${k.label}\n${m.detail}`}
                          />
                        );
                      }),
                  )}
                  <span
                    className="ribbon__head"
                    style={{ left: `${pct(nowMs)}%` }}
                  />
                </div>
                <div className="ribbon__scale mono">
                  <span>{timecode(0)}</span>
                  <b>{timecode(nowMs)}</b>
                  <span>{timecode(bundle.duration_ms)}</span>
                </div>
              </div>
            }
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
                {
                  subjectName(focused.track_id, focused.seat, focused.seat_state)
                    .name
                }
              </h3>
              <StateChip
                state={decisions[focused.track_id] ?? focused.state}
                size="sm"
              />
              <button type="button" onClick={() => setFocus(null)}>
                Show everyone
              </button>
            </header>
            <p>
              The timeline above is showing only this person&rsquo;s marks.
            </p>
          </section>
        )}
      </div>

      <aside className="video__aside">
        {/* The dropdown, and the numbers underneath it. A wall of flag names
            next to the video was unreadable; the counts are the part a
            reviewer scans, so they get the space and the names get folded. */}
        <div className="picker" ref={pickerRef}>
          <button
            type="button"
            className="picker__button"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((o) => !o)}
          >
            <span>
              {shown.length} of {kinds.length} findings shown
            </span>
            <i aria-hidden="true">{pickerOpen ? "▲" : "▼"}</i>
          </button>

          {pickerOpen && (
            <div className="picker__menu">
              {kinds.length === 0 && (
                <p className="picker__none">
                  This run produced no flags to show.
                </p>
              )}
              {kinds.map((k) => (
                <label key={k.id}>
                  <input
                    type="checkbox"
                    checked={on.has(k.id)}
                    onChange={() => toggle(k.id)}
                  />
                  <i style={{ background: k.color }} aria-hidden="true" />
                  <span>{k.label}</span>
                  <b className="mono">{k.people}</b>
                </label>
              ))}
              <div className="picker__all">
                <button
                  type="button"
                  onClick={() => setChosen(new Set(kinds.map((k) => k.id)))}
                >
                  All
                </button>
                <button type="button" onClick={() => setChosen(new Set())}>
                  None
                </button>
                <button type="button" onClick={() => setChosen(null)}>
                  Default
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="ftiles">
          {shown.map((k) => (
            <button
              key={k.id}
              type="button"
              className="ftile"
              style={{ ["--ftile" as string]: k.color }}
              title={k.note}
              onClick={() => {
                const first = k.marks
                  .slice()
                  .sort((a, b) => a.from_ms - b.from_ms)[0];
                if (first) setSeek(first.from_ms);
              }}
            >
              <b className="mono">{k.people}</b>
              <span>{k.label}</span>
              <em className="mono">
                {k.marks.length} mark{k.marks.length === 1 ? "" : "s"}
              </em>
            </button>
          ))}
          {shown.length === 0 && (
            <p className="ftiles__none">
              Nothing selected. Open the dropdown above to choose what the
              timeline shows.
            </p>
          )}
        </div>

        {dismissedCount > 0 && (
          <p className="video__hidden mono">
            {dismissedCount} hidden — marked not a violation
          </p>
        )}

        <p className="video__legend mono">Isolate a person</p>
        <ul className="video__people">
          <li>
            <button
              type="button"
              className={focus === null ? "is-on" : ""}
              onClick={() => setFocus(null)}
            >
              <span>Everyone</span>
            </button>
          </li>
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
                <StateChip
                  state={decisions[t.track_id] ?? t.state}
                  size="sm"
                />
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
