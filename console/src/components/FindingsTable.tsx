import { useMemo } from "react";
import type { Bundle } from "../types";
import type { CropManifest, Decision } from "../review";
import { subjectName, timecode } from "../lib/format";
import { classLabel, verdictLabel } from "../lib/humanize";
import "./FindingsTable.css";

export interface Finding {
  track_id: number;
  at_ms: number;
  /** What kind of claim this is. The three tiers are not interchangeable and
   *  the table never merges them into one "detections" number. */
  tier: "human" | "second_model" | "proposed";
  what: string;
  detail: string;
}

/**
 * What was actually caught, in one list, newest question first.
 *
 * The dashboard counts states; this answers the different question a reviewer
 * asks in front of the video -- *show me the ones that matter and take me
 * there*. Every row seeks the player.
 *
 * The tiers are kept visually distinct on purpose:
 *
 *   confirmed by a reviewer   a human looked and said yes
 *   confirmed by SAM 3        a second model backed the object claim
 *   proposed                  a detector fired and nothing has backed it
 *
 * Collapsing those into one list of "detections" would be the exact failure
 * the output contract exists to prevent: a proposal is not a finding, and a
 * second model agreeing is not a person having cheated.
 */
export function FindingsTable({
  bundle,
  crops,
  decisions,
  onSeek,
  focus,
}: {
  bundle: Bundle;
  crops: CropManifest;
  decisions: Record<number, Decision>;
  onSeek: (ms: number, trackId: number) => void;
  focus: number | null;
}) {
  const findings = useMemo<Finding[]>(() => {
    const rows: Finding[] = [];

    for (const track of bundle.tracks) {
      const crop = crops[String(track.track_id)];
      const decision = decisions[track.track_id];

      // A reviewer's yes outranks everything. It is also the only row here
      // that is a statement about a person rather than about pixels.
      if (decision === "human_confirmed") {
        rows.push({
          track_id: track.track_id,
          at_ms: crop?.key_pts_ms ?? track.first_seen_ms ?? 0,
          tier: "human",
          what: `${classLabel(crop?.key_class)} — confirmed by a reviewer`,
          detail: crop?.key_verdict
            ? `Second model: ${verdictLabel(crop.key_verdict)}`
            : "Confirmed from the review queue",
        });
        continue;
      }
      // A dismissal is a decision too: it takes the row out, it does not
      // demote it to a proposal.
      if (decision === "human_dismissed") continue;

      if (crop?.key_supported) {
        rows.push({
          track_id: track.track_id,
          at_ms: crop.key_pts_ms,
          tier: "second_model",
          what: `${classLabel(crop.key_class)} at the hand`,
          detail: `${verdictLabel(crop.key_verdict)} · ${crop.supported_frames} frame${
            crop.supported_frames === 1 ? "" : "s"
          } backed`,
        });
        continue;
      }

      if (track.state === "review_candidate" && crop) {
        rows.push({
          track_id: track.track_id,
          at_ms: crop.key_pts_ms,
          tier: "proposed",
          what: `possible ${classLabel(crop.key_class)}`,
          detail: crop.key_verdict
            ? verdictLabel(crop.key_verdict)
            : "not sent to the second model",
        });
      }
    }

    const rank = { human: 0, second_model: 1, proposed: 2 };
    return rows.sort(
      (a, b) => rank[a.tier] - rank[b.tier] || a.at_ms - b.at_ms,
    );
  }, [bundle.tracks, crops, decisions]);

  const counts = {
    human: findings.filter((f) => f.tier === "human").length,
    second_model: findings.filter((f) => f.tier === "second_model").length,
    proposed: findings.filter((f) => f.tier === "proposed").length,
  };

  if (!findings.length) {
    return (
      <section className="ft">
        <h3>What was caught</h3>
        <p className="ft__none">
          Nothing in this recording has been backed by the second model or
          confirmed by a reviewer. That is not the same as
          &ldquo;nothing happened&rdquo; — it means nothing cleared the bar.
        </p>
      </section>
    );
  }

  return (
    <section className="ft">
      <h3>
        What was caught
        <span className="mono">
          {counts.human} confirmed by a reviewer · {counts.second_model} backed
          by the second model · {counts.proposed} proposed only
        </span>
      </h3>

      <table>
        <thead>
          <tr>
            <th scope="col">At</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Standing</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => {
            const track = bundle.tracks.find((t) => t.track_id === f.track_id);
            const subject = subjectName(
              f.track_id,
              track?.seat ?? null,
              track?.seat_state ?? null,
            );
            return (
              <tr
                key={`${f.tier}-${f.track_id}`}
                className={`is-${f.tier} ${focus === f.track_id ? "is-on" : ""}`}
                onClick={() => onSeek(f.at_ms, f.track_id)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSeek(f.at_ms, f.track_id);
                  }
                }}
              >
                <td className="mono">{timecode(f.at_ms)}</td>
                <td>{subject.name}</td>
                <td>{f.what}</td>
                <td className="ft__detail">{f.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="ft__note">
        Click a row to jump the video there. A row backed by the second model is
        a machine agreeing with a machine — it is still a question for a human,
        not a verdict.
      </p>
    </section>
  );
}
