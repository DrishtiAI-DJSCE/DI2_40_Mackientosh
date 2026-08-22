import { useCallback, useEffect, useRef, useState } from "react";
import type { OverlayBundle, OverlayFrame } from "../overlay";
import { nearestFrame } from "../overlay";
import "./WipePlayer.css";

export interface Layers {
  boxes: boolean;
  skeletons: boolean;
  ids: boolean;
  objects: boolean;
  wrists: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  boxes: true,
  skeletons: true,
  ids: true,
  objects: true,
  wrists: true,
};

export const LAYER_LABEL: Record<keyof Layers, string> = {
  boxes: "person boxes",
  skeletons: "skeletons",
  ids: "track ids",
  objects: "object boxes",
  wrists: "wrist markers",
};

/** Resist progressively past a boundary instead of stopping dead. A hard stop
 *  reads as frozen; continuous resistance reads as "responsive, but there is
 *  nothing more here". */
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}

function css(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/**
 * Raw footage on the left, our marks on the right, split by a handle the
 * reviewer drags.
 *
 * A blend slider was the obvious alternative and it is worse: at 50% opacity
 * you cannot tell whether a faint edge is our box or the desk bezel, which is
 * precisely the judgement this component exists to support. A hard wipe keeps
 * both sides at full fidelity and puts the comparison on the boundary, where
 * the eye is most sensitive.
 *
 * The marks are drawn on a canvas rather than baked into a second video, so
 * layers can be switched off and a box can say which track it belonged to.
 */
export function WipePlayer({
  videoSrc,
  overlay,
  layers,
  focusTrack,
  onTimeUpdate,
  seekToMs,
}: {
  videoSrc: string;
  overlay: OverlayBundle | null;
  layers: Layers;
  focusTrack?: number | null;
  onTimeUpdate?: (ms: number) => void;
  seekToMs?: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Wipe position as a fraction. Kept in a ref for the draw loop and mirrored
  // into state only for the handle's own transform, so dragging never
  // re-renders the tree.
  const wipeRef = useRef(0.5);
  const [wipe, setWipe] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const dragRef = useRef<{ id: number; grabDx: number } | null>(null);
  const layersRef = useRef(layers);
  const focusRef = useRef<number | null | undefined>(focusTrack);
  layersRef.current = layers;
  focusRef.current = focusTrack;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !overlay) return;

    const w = overlay.width;
    const h = overlay.height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const frame: OverlayFrame | null = nearestFrame(
      overlay,
      video.currentTime * 1000,
    );
    if (!frame) return;

    // Everything we draw is confined to the right of the handle, so the left
    // half stays the untouched decoded frame.
    const splitX = wipeRef.current * w;
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, w - splitX, h);
    ctx.clip();

    const L = layersRef.current;
    const focus = focusRef.current;
    const accent = css("--accent-2", "#8acfe6");
    const objectColor = css("--lane-object", "#e5825c");
    const dim = css("--slate", "#93a1ac");

    for (const person of frame.p) {
      const isFocus = focus === undefined || focus === null || focus === person.i;
      ctx.globalAlpha = isFocus ? 1 : 0.28;
      const [x1, y1, x2, y2] = person.b;

      if (L.boxes) {
        ctx.strokeStyle = isFocus ? accent : dim;
        ctx.lineWidth = isFocus ? 2 : 1;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      }

      if (L.ids) {
        const label = `#${person.i}`;
        ctx.font = "600 13px ui-monospace, Menlo, monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,.62)";
        ctx.fillRect(x1, Math.max(y1 - 17, 0), tw + 8, 16);
        ctx.fillStyle = isFocus ? accent : dim;
        ctx.fillText(label, x1 + 4, Math.max(y1 - 5, 11));
      }

      if (L.skeletons) {
        ctx.strokeStyle = isFocus ? accent : dim;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const [a, b] of overlay.bones) {
          const ax = person.j[a * 2];
          const ay = person.j[a * 2 + 1];
          const bx = person.j[b * 2];
          const by = person.j[b * 2 + 1];
          // -1 is the "not visible" sentinel; a bone with a missing end is
          // simply not drawn rather than drawn to the origin.
          if (ax < 0 || ay < 0 || bx < 0 || by < 0) continue;
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }

      if (L.wrists) {
        for (const idx of [9, 10]) {
          const wx = person.j[idx * 2];
          const wy = person.j[idx * 2 + 1];
          if (wx < 0 || wy < 0) continue;
          ctx.beginPath();
          ctx.arc(wx, wy, 4, 0, Math.PI * 2);
          ctx.fillStyle = isFocus ? accent : dim;
          ctx.fill();
        }
      }

      if (L.objects && person.o) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = objectColor;
        for (const obj of person.o) {
          const [ox1, oy1, ox2, oy2] = obj.b;
          ctx.strokeRect(ox1, oy1, ox2 - ox1, oy2 - oy1);
        }
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }, [overlay]);

  // The time callback lives in a ref so it can never be an effect dependency.
  // Passed as one it re-created the rAF loop on every render, and since the
  // callback itself sets state each frame that was a render storm that
  // cancelled the loop faster than it could schedule itself.
  const timeCbRef = useRef(onTimeUpdate);
  timeCbRef.current = onTimeUpdate;

  // One display-synced loop, owned by the component for its whole life.
  // `draw` is read through a ref for the same reason: the loop must survive
  // an overlay arriving, not be torn down and rebuilt by it.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    let raf = 0;
    let alive = true;
    // Publishing the playhead at ~12 Hz is well under a frame but far above
    // the eye's threshold for a moving cursor, and it keeps the 236-row
    // person list from re-rendering sixty times a second.
    let lastPublish = 0;

    const tick = (now: number) => {
      if (!alive) return;
      drawRef.current();
      const v = videoRef.current;
      if (v && timeCbRef.current && now - lastPublish > 80) {
        lastPublish = now;
        timeCbRef.current(v.currentTime * 1000);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    // rAF is not a complete answer. A hidden tab, a background window and a
    // paused video all stop it, and in every one of those cases the marks
    // still have to be correct the moment the picture changes -- a seek while
    // paused being the obvious one. So the same draw is also bound to the
    // video's own events, which fire regardless of compositing.
    const video = videoRef.current;
    const repaint = () => drawRef.current();
    const events = ["seeked", "loadeddata", "timeupdate", "play", "pause"];
    for (const name of events) video?.addEventListener(name, repaint);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      for (const name of events) video?.removeEventListener(name, repaint);
    };
  }, []);

  // Repaint when anything that changes the picture changes, so a layer toggle
  // or a wipe drag is reflected immediately even with the loop stalled.
  useEffect(() => {
    draw();
  }, [draw, layers, focusTrack, wipe]);

  useEffect(() => {
    if (seekToMs === null || seekToMs === undefined) return;
    const v = videoRef.current;
    if (v) v.currentTime = seekToMs / 1000;
  }, [seekToMs]);

  const applyWipe = useCallback((fraction: number) => {
    const stage = stageRef.current;
    const width = stage?.clientWidth ?? 1;
    let next = fraction;
    if (next < 0) next = rubberband(next, width) / width;
    if (next > 1) next = 1 + rubberband(next - 1, width) / width;
    next = Math.max(-0.04, Math.min(1.04, next));
    wipeRef.current = Math.max(0, Math.min(1, next));
    setWipe(next);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const handleX = rect.left + wipeRef.current * rect.width;
    // Respect where they grabbed: snapping the handle to the pointer would
    // break the illusion on the first pixel of movement.
    dragRef.current = { id: e.pointerId, grabDx: e.clientX - handleX };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || drag.id !== e.pointerId || !stage) return;
    const rect = stage.getBoundingClientRect();
    applyWipe((e.clientX - drag.grabDx - rect.left) / rect.width);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    // Settle back inside the bounds if the rubber band was stretched.
    applyWipe(Math.max(0, Math.min(1, wipeRef.current)));
  };

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        v.currentTime = Math.max(0, v.currentTime - 1);
      } else if (e.key === "ArrowRight") {
        v.currentTime = v.currentTime + 1;
      } else if (e.key === ",") {
        v.currentTime = Math.max(0, v.currentTime - 1 / 25);
      } else if (e.key === ".") {
        v.currentTime = v.currentTime + 1 / 25;
      } else if (e.key === "\\") {
        applyWipe(0.5);
      } else if (e.key === "a") {
        applyWipe(wipeRef.current > 0.5 ? 0 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, applyWipe]);

  const pct = `${(wipe * 100).toFixed(3)}%`;

  return (
    <div className="wipe">
      <div
        className="wipe__stage"
        ref={stageRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <video
          ref={videoRef}
          src={videoSrc}
          playsInline
          muted
          preload="metadata"
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        <canvas ref={canvasRef} />

        <span className="wipe__tag wipe__tag--l">raw</span>
        <span className="wipe__tag wipe__tag--r">annotated</span>

        <div
          className="wipe__handle"
          style={{ left: pct }}
          onPointerDown={onPointerDown}
          role="slider"
          tabIndex={0}
          aria-label="Reveal annotations"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(wipe * 100)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              applyWipe(wipeRef.current + (e.key === "ArrowLeft" ? -0.02 : 0.02));
            }
          }}
        >
          <i />
        </div>
      </div>

      <div className="wipe__bar">
        <button type="button" onClick={toggle} className="wipe__play">
          {playing ? "Pause" : "Play"}
        </button>
        <span className="wipe__hint mono">
          drag the handle &middot; <kbd>a</kbd> flip &middot; <kbd>\</kbd> centre
          &middot; <kbd>,</kbd> <kbd>.</kbd> frame step
        </span>
      </div>
    </div>
  );
}
