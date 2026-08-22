import type { ProjectRef } from "./review";

/**
 * The hall hierarchy: exam > centre > recording.
 *
 * One recording is wired to real artifacts. The rest are declared and marked
 * `processed: false`, because the deployment shape has to be visible before
 * the runs exist -- and an unprocessed video must say so on its face rather
 * than showing an empty dashboard that reads like "nothing was found".
 *
 * Replace this with the D1 query once the control plane is up; the shape is
 * already what that query returns.
 */
export const PROJECTS: ProjectRef[] = [
  {
    id: "cet-2026",
    name: "CET Exam 2026",
    centres: [
      {
        id: "dahisar",
        name: "Dahisar Centre",
        videos: [
          {
            id: "1512_12_paper",
            name: "Hall 3 · Seat 12 · paper handling",
            bundle: "/data/1512_12_paper.json",
            overlay: "/data/1512_12_paper.overlay.json",
            video: "/media/1512_12_paper.mp4",
            crops: "/crops/1512_12_paper",
            processed: true,
          },
          {
            id: "dahisar-hall1-cam2",
            name: "Hall 1 · Camera 2",
            processed: false,
          },
          {
            id: "dahisar-hall2-cam1",
            name: "Hall 2 · Camera 1",
            processed: false,
          },
        ],
      },
      {
        id: "thane",
        name: "Thane Centre",
        videos: [
          { id: "thane-hall1-cam1", name: "Hall 1 · Camera 1", processed: false },
          { id: "thane-hall1-cam3", name: "Hall 1 · Camera 3", processed: false },
        ],
      },
    ],
  },
];

export function findVideo(projects: ProjectRef[], videoId: string) {
  for (const p of projects) {
    for (const c of p.centres) {
      const v = c.videos.find((x) => x.id === videoId);
      if (v) return { project: p, centre: c, video: v };
    }
  }
  return null;
}

export function firstProcessed(projects: ProjectRef[]) {
  for (const p of projects) {
    for (const c of p.centres) {
      const v = c.videos.find((x) => x.processed);
      if (v) return { project: p, centre: c, video: v };
    }
  }
  return null;
}
