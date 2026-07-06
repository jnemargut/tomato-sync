// Pour Over adapter — the slow NPR listening app.
// Pour Over streams its audio live (top-of-the-hour news, Tiny Desk, station
// live streams) rather than pre-placing big files, so there's no content to
// mirror or prune. This adapter exists so the updater sees the app and keeps
// its .pdx current, exactly like the footnotes adapter.

import fs from "node:fs";
import path from "node:path";
import { dataDirFor, gamesRoot } from "../core.mjs";

const BUNDLE = "com.jontomato.pourover";

function installedPdx() {
  const g = gamesRoot();
  if (!g) return false;
  let entries;
  try { entries = fs.readdirSync(g, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.toLowerCase().endsWith(".pdx")) continue;
    try {
      const info = fs.readFileSync(path.join(g, e.name, "pdxinfo"), "utf8");
      if (info.includes(`bundleID=${BUNDLE}`)) return true;
    } catch { /* unreadable pdx — skip */ }
  }
  return false;
}

async function sync() {
  return { ok: true, added: [], removed: [], summary: "streams live — nothing to sync" };
}

export default {
  id: "pourover",
  name: "Pour Over",
  bundleId: BUNDLE,
  detect: () => fs.existsSync(dataDirFor(BUNDLE)) || installedPdx(),
  sync,
};
