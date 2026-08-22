/** Shapes from tools/build_review_crops.py, plus the reviewer's own decision. */

export type Decision = "confirmed" | "dismissed" | "needs_better_view";

export interface StripFrame {
  pts_ms: number;
  file: string;
  /** True when SAM 3 backed an object in this frame. */
  supported: boolean;
  n: number;
}

export interface CropEntry {
  track_id: number;
  key_pts_ms: number;
  key_class: string | null;
  key_confidence: number | null;
  key_verdict: string | null;
  key_supported: boolean;
  wrist_distance_norm: number | null;
  nearest_wrist: string | null;
  supported_frames: number;
  proposals: number;
  sightings: number;
  key?: string;
  /** The same crop with nothing drawn on it, for the vision model. */
  raw?: string;
  frame?: string;
  /** SAM 3's own annotated crop for the key instant, when it was adjudicated. */
  sam3_crop?: string;
  strip: StripFrame[];
}

export type CropManifest = Record<string, CropEntry>;

/** A project is a hall's worth of recordings: CET Exam > Dahisar > 50 videos.
 *  Only one video is wired to real artifacts today; the rest are declared so
 *  the shape of the deployment is visible, and each says plainly that it has
 *  not been processed. */
export interface VideoRef {
  id: string;
  name: string;
  /** Present only when a run bundle exists for it. */
  bundle?: string;
  overlay?: string;
  video?: string;
  crops?: string;
  processed: boolean;
}

export interface CentreRef {
  id: string;
  name: string;
  videos: VideoRef[];
}

export interface ProjectRef {
  id: string;
  name: string;
  centres: CentreRef[];
}
