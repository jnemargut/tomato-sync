// footnotes adapter — the pedometer.
// footnotes keeps ALL step data on the device (/Shared/Steps) by explicit
// design: private by default, nothing to mirror, nothing to prune. This
// adapter exists so the updater sees the app and keeps its .pdx current.
// detect() can't use Data/<bundle> like the others (footnotes never writes
// there — its data lives in /Shared), so it looks for the installed .pdx or
// the shared steps folder.

import fs from "node:fs";
import path from "node:path";
import { gamesRoot } from "../core.mjs";

const BUNDLE = "com.jontomato.footnotes";

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

function sharedSteps() {
  const g = gamesRoot();
  if (!g) return false;
  return fs.existsSync(path.join(g, "..", "Shared", "Steps", "steps.json"));
}

async function sync() {
  return { ok: true, added: [], removed: [], summary: "steps stay on device (private by design)" };
}

export default {
  id: "footnotes",
  name: "footnotes",
  bundleId: BUNDLE,
  detect: () => installedPdx() || sharedSteps(),
  sync,
};
