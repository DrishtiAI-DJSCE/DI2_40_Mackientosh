import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bundle, Track } from "../types";
import type { CropEntry, CropManifest, Decision } from "../review";
import { StateChip } from "../components/StateChip";
import { seconds, subjectName, timecode } from "../lib/format";
import {
  classLabel,
  conditionMeaning,
  conditionQuestion,
  flagLabel,
  headline,
  verdictLabel,
} from "../lib/humanize";
import "./ReviewScreen.css";

interface Gemma {
  state: "idle" | "running" | "done" | "error";
  title?: string;
  description?: string;
  object_guess?: string;
  confidence?: string;
  error?: string;
}

/** Fetch an image and turn it into the data: URL the proxy expects. Done in
 *  the client so the server never has to reach back into the crop folder. */
async function toDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * One person, one screen, one decision.
 *
 * The queue was 236 cards deep and unreadable. What a reviewer needs is the
 * picture, a sentence saying why they are looking at it, and three keys. The
 * arithmetic is still here, underneath, because the contract requires a card
 * to be able to show its own working -- but it is folded away by default,
 * because the working is what you check *after* the picture surprises you.
 */
export function ReviewScreen({
  bundle,
  crops,
  cropBase,
  decisions,
  onDecide,
}: {
  bundle: Bundle;
  crops: CropManifest;
  cropBase: string;
  decisions: Record<number, Decision>;
  onDecide: (trackId: number, decision: Decision) => void;
}) {
  // Only people with a picture can be reviewed. Everyone else is in the
  // register, not the queue -- asking for a verdict on a person we cannot show
  // would be asking someone to guess.
  const queue = useMemo(() => {
    const withCrops = bundle.tracks.filter((t) => crops[String(t.track_id)]);
    return withCrops.sort((a, b) => {
      const ca = crops[String(a.track_id)];
      const cb = crops[String(b.track_id)];
      // Confirmed detections first, then priority. That is the order a
      // reviewer's attention is worth most.
      if (ca.key_supported !== cb.key_supported) return ca.key_supported ? -1 : 1;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });
  }, [bundle.tracks, crops]);

  const [index, setIndex] = useState(0);
  const [showWorking, setShowWorking] = useState(false);
  const [gemma, setGemma] = useState<Record<number, Gemma>>({});

  const track: Track | undefined = queue[index];
  const crop: CropEntry | undefined = track
    ? crops[String(track.track_id)]
    : undefined;

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => Math.max(0, Math.min(queue.length - 1, i + delta)));
      setShowWorking(false);
    },
    [queue.length],
  );

  const decide = useCallback(
    (d: Decision) => {
      if (!track) return;
      onDecide(track.track_id, d);
      // Advance immediately. A reviewer who has decided is done with this
      // person; making them press Next as well is a second keystroke for no
      // information.
      setTimeout(() => step(1), 90);
    },
    [track, onDecide, step],
  );

  const runGemma = useCallback(async () => {
    if (!track || !crop) return;
    // Always the unannotated crop: a model shown our own boxes describes them
    // back as objects, which is not a second opinion.
    const source = crop.raw ?? crop.key;
    if (!source) return;
    const id = track.track_id;
    if (gemma[id]?.state === "running" || gemma[id]?.state === "done") return;
    setGemma((g) => ({ ...g, [id]: { state: "running" } }));
    try {
      const image = await toDataUrl(`${cropBase}/${source}`);
      const res = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const doc = await res.json();
      if (!res.ok) throw new Error(doc.error ?? `HTTP ${res.status}`);
      if (doc.parsed) {
        setGemma((g) => ({ ...g, [id]: { state: "done", ...doc.parsed } }));
      } else {
        setGemma((g) => ({
          ...g,
          [id]: { state: "done", description: doc.raw ?? "No answer." },
        }));
      }
    } catch (e) {
      setGemma((g) => ({ ...g, [id]: { state: "error", error: String(e) } }));
    }
  }, [track, crop, cropBase, gemma]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "n") step(1);
      else if (e.key === "ArrowLeft" || e.key === "p") step(-1);
      else if (e.key === "1" || e.key === "c") decide("confirmed");
      else if (e.key === "2" || e.key === "d") decide("dismissed");
      else if (e.key === "3" || e.key === "b") decide("needs_better_view");
      else if (e.key === "g") void runGemma();
      else if (e.key === "w") setShowWorking((s) => !s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, decide, runGemma]);

  if (!queue.length) {
    return (
      <p className="rv__empty">
        No person in this run has a reviewable frame. Build crops with
        <code> tools/build_review_crops.py</code>.
      </p>
    );
  }
  if (!track || !crop) return null;

  const subject = subjectName(track.track_id, track.seat, track.seat_state);
  const decided = decisions[track.track_id];
  const g = gemma[track.track_id];
  const done = Object.keys(decisions).length;

  return (
    <div className="rv">
      <header className="rv__top">
        <div className="rv__progress">
          <b className="mono">
            {index + 1} / {queue.length}
          </b>
          <span>{done} decided</span>
          <div className="rv__bar">
            <i style={{ width: `${((index + 1) / queue.length) * 100}%` }} />
          </div>
        </div>
        <div className="rv__nav">
          <button type="button" onClick={() => step(-1)} disabled={index === 0}>
            Previous
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={index === queue.length - 1}
          >
            Next
          </button>
        </div>
      </header>

      <div className="rv__body">
        <figure className="rv__shot">
          <img
            src={`${cropBase}/${crop.key}`}
            alt={`${subject.name} at ${timecode(crop.key_pts_ms)}`}
          />
          <figcaption className="mono">
            {timecode(crop.key_pts_ms)} &middot; {classLabel(crop.key_class)}{" "}
            {crop.key_confidence != null &&
              `· detector ${(crop.key_confidence * 100).toFixed(0)}%`}
          </figcaption>
        </figure>

        <div className="rv__side">
          <div className="rv__who">
            <h2>{subject.name}</h2>
            {subject.qualifier && (
              <span className="rv__qual">{subject.qualifier}</span>
            )}
            <StateChip state={decided ? decisionState(decided) : track.state} />
          </div>

          <p
            className={`rv__headline ${crop.key_supported ? "is-strong" : ""}`}
          >
            {headline(crop.key_supported, crop.key_class, crop.key_verdict)}
          </p>

          <ul className="rv__facts">
            <li>
              <span>Second model</span>
              <b>{verdictLabel(crop.key_verdict)}</b>
            </li>
            {/* `proposals` counts every object seen near this person's hands
                across the whole track, most of it keyboards and monitors. It
                is context, not a denominator -- "5 of 8,729" reads as a 0.06%
                hit rate, which is not what either number means. */}
            <li>
              <span>Frames it confirmed</span>
              <b>{crop.supported_frames.toLocaleString()}</b>
            </li>
            <li>
              <span>Times seen</span>
              <b>{crop.sightings.toLocaleString()}</b>
            </li>
            <li>
              <span>Distance to hand</span>
              <b>
                {crop.wrist_distance_norm != null && crop.wrist_distance_norm >= 0
                  ? `${crop.wrist_distance_norm.toFixed(2)} body widths`
                  : "not recorded"}
              </b>
            </li>
            <li>
              <span>Seen for</span>
              <b>
                {seconds(
                  (track.last_seen_ms ?? 0) - (track.first_seen_ms ?? 0),
                )}
              </b>
            </li>
          </ul>

          {track.flags.length > 0 && (
            <details className="rv__flags">
              <summary>
                {track.flags.length} flag{track.flags.length === 1 ? "" : "s"}
              </summary>
              <ul>
                {track.flags.map((f) => (
                  <li key={f.flag}>
                    <b>{flagLabel(f.flag)}</b>
                    <span>{f.evidence}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="rv__gemma">
            <button
              type="button"
              onClick={() => void runGemma()}
              disabled={g?.state === "running" || g?.state === "done"}
            >
              {g?.state === "running"
                ? "Reading the image…"
                : g?.state === "done"
                  ? "Analysed"
                  : "Ask Gemma what it sees"}
            </button>
            {g?.state === "done" && (
              <div className="rv__answer">
                {g.title && <h4>{g.title}</h4>}
                <p>{g.description}</p>
                {g.object_guess && (
                  <span className="mono">
                    reads as {classLabel(g.object_guess)} &middot; {g.confidence}
                  </span>
                )}
                <em>A description of the picture. Not a verdict.</em>
              </div>
            )}
            {g?.state === "error" && (
              <p className="rv__err mono">{g.error}</p>
            )}
          </div>
        </div>
      </div>

      <div className="rv__actions">
        <button
          type="button"
          className="is-confirm"
          onClick={() => decide("confirmed")}
        >
          Confirm <kbd>1</kbd>
        </button>
        <button
          type="button"
          className="is-dismiss"
          onClick={() => decide("dismissed")}
        >
          Not a violation <kbd>2</kbd>
        </button>
        <button
          type="button"
          className="is-abstain"
          onClick={() => decide("needs_better_view")}
        >
          Can't tell <kbd>3</kbd>
        </button>
        <button
          type="button"
          className="is-plain"
          onClick={() => setShowWorking((s) => !s)}
        >
          {showWorking ? "Hide" : "Show"} the reasoning <kbd>w</kbd>
        </button>
      </div>

      {showWorking && (
        <section className="rv__working">
          <h3>How the system got here</h3>
          <ol>
            {track.conditions.map((c) => (
              <li key={c.name} className={c.passed ? "is-pass" : "is-fail"}>
                <div className="rv__q">
                  <span>{c.passed ? "Yes" : "No"}</span>
                  <b>{conditionQuestion(c.name)}</b>
                </div>
                <p>{conditionMeaning(c.name, c.passed)}</p>
                <p className="rv__detail mono">{c.detail}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {crop.strip.length > 0 && (
        <section className="rv__strip">
          <h3>
            Every sampled moment
            <span className="mono">
              {crop.strip.length} of {crop.sightings} sightings
            </span>
          </h3>
          <div className="rv__thumbs">
            {crop.strip.map((s) => (
              <figure
                key={s.file}
                className={s.supported ? "is-strong" : ""}
                title={`${timecode(s.pts_ms)} · ${s.n} proposal(s)`}
              >
                <img src={`${cropBase}/${s.file}`} alt={timecode(s.pts_ms)} />
                <figcaption className="mono">{timecode(s.pts_ms)}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function decisionState(d: Decision) {
  return d === "confirmed"
    ? ("human_confirmed" as const)
    : d === "dismissed"
      ? ("human_dismissed" as const)
      : ("needs_better_view" as const);
}
