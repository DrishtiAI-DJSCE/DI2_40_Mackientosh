import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(file = process.env.DRISHTI_DB ?? join(here, "drishti.db")) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}

export const nowUtc = () => new Date().toISOString();

/** Slug that stays readable in a URL and stays unique without a UUID column. */
export function slug(name, existing) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "item";
  if (!existing.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}
