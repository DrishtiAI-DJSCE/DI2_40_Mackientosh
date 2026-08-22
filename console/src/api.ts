/** Thin client over the console API. Nothing here is seeded or invented:
 *  if the tree is empty it is because nobody has created a project yet, and
 *  the UI says exactly that instead of showing example centres. */
import type { ProjectRef, VideoRef } from "./review";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const doc = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(doc?.error ?? `${res.status} ${res.statusText}`);
  return doc as T;
}

export interface Asset {
  url: string;
  name: string;
  bytes: number;
}
export interface Assets {
  media: Asset[];
  bundles: Asset[];
  overlays: Asset[];
  crops: Asset[];
}

export interface DecisionRow {
  id: number;
  video_id: string;
  track_id: number;
  decision: "human_confirmed" | "human_dismissed" | "needs_better_view";
  machine_state: string | null;
  key_class: string | null;
  key_verdict: string | null;
  key_pts_ms: number | null;
  note: string | null;
  reviewer: string;
  decided_utc: string;
}

export const api = {
  tree: () => call<{ projects: ProjectRef[] }>("/api/tree"),
  assets: () => call<Assets>("/api/assets"),

  createProject: (name: string) =>
    call<{ projects: ProjectRef[] }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  createCentre: (projectId: string, name: string) =>
    call<{ projects: ProjectRef[] }>(`/api/projects/${projectId}/centres`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  createVideo: (centreId: string, body: Partial<VideoRef> & { name: string }) =>
    call<{ projects: ProjectRef[] }>(`/api/centres/${centreId}/videos`, {
      method: "POST",
      body: JSON.stringify({
        name: body.name,
        media_url: body.video,
        bundle_url: body.bundle,
        overlay_url: body.overlay,
        crops_url: body.crops,
      }),
    }),

  remove: (kind: "projects" | "centres" | "videos", id: string) =>
    call<{ projects: ProjectRef[] }>(`/api/${kind}/${id}`, { method: "DELETE" }),

  decisions: (videoId: string) =>
    call<{ current: Record<string, DecisionRow>; revisions: number }>(
      `/api/videos/${videoId}/decisions`,
    ),

  decide: (
    videoId: string,
    body: {
      track_id: number;
      decision: DecisionRow["decision"];
      machine_state?: string | null;
      key_class?: string | null;
      key_verdict?: string | null;
      key_pts_ms?: number | null;
      note?: string | null;
    },
  ) =>
    call<DecisionRow>(`/api/videos/${videoId}/decisions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  describe: (image: string) =>
    call<{
      parsed: {
        title?: string;
        description?: string;
        object_guess?: string;
        confidence?: string;
      } | null;
      raw: string | null;
    }>("/api/vision", {
      method: "POST",
      body: JSON.stringify({ image }),
    }),
};
