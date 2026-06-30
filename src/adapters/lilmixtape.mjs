// lilmixtape adapter — the mixtape, one tape at a time.
// A bleep-bloop loads a tape id onto the device (saved in the lmx.activeTape
// datastore). lilmixtape keeps exactly ONE tape on disk (plus the demo reel) at
// tapes/<id>/, pulling each track's files from R2. The companion mirrors that:
//   • read the active tape id off the device,
//   • fetch its manifest, download each track's seekable files (.pdv + .mp3) so it
//     plays offline with no loading — UNLESS delivery is "stream" (then skip),
//   • keep only the active tape (+ demo), purge other tapes.
// "downloaded" = the .pdv exists (or legacy .rwlpv). No device-app changes.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { dataDirFor, loadJson, existsAsync, downloadTo, fetchJson, human } from "../core.mjs";
import { LILMIXTAPE_HOST } from "../endpoints.mjs";

const BUNDLE = "com.jontomato.lilmixtape";
const base = `https://${LILMIXTAPE_HOST}`;                    // content host (resolved from config)
const WEB = "https://lilmixtape.com";
const DEMO_ID = "tFatIDPLJK";                                  // == Config.DEMO_ID (never purged)
const ACTIVE_KEY = "lmx.activeTape";                           // == Config.SLUG_KEY
const DELIVERY_KEY = "lmx.delivery";                           // "stream" | "download" | "stream_save"

// Playdate datastore writes each key to <key>.json (a JSON-encoded value).
async function readDatastore(DATA_DIR, key, dflt) {
  for (const f of [`${key}.json`, key]) {
    try {
      const raw = await fsp.readFile(`${DATA_DIR}/${f}`, "utf8");
      try { const v = JSON.parse(raw); if (typeof v === "string") return v; if (v && typeof v === "object") return v.value ?? v.data ?? dflt; return v ?? dflt; }
      catch { return raw.trim().replace(/^"|"$/g, "") || dflt; }
    } catch { /* try next */ }
  }
  return dflt;
}

// Active tape id: prefer the datastore; fall back to the lone non-demo tapes/<id>/.
async function activeTapeId(DATA_DIR) {
  const fromStore = await readDatastore(DATA_DIR, ACTIVE_KEY, null);
  if (fromStore) return String(fromStore);
  try {
    const dirs = (await fsp.readdir(`${DATA_DIR}/tapes`, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== DEMO_ID).map((d) => d.name);
    return dirs[0] || null;
  } catch { return null; }
}

const placesLocal = (m) => m !== "stream";   // download + stream_save keep a local copy

async function sync({ dryRun = false, onLog = () => {} } = {}) {
  const DATA_DIR = dataDirFor(BUNDLE);
  const id = await activeTapeId(DATA_DIR);
  if (!id) return { ok: true, reason: "no tape loaded", added: [], removed: [], summary: "No mixtape on the device yet" };

  let manifest;
  try { manifest = await fetchJson(`${base}/tapes/${id}/manifest.json`); }
  catch (e) { return { ok: false, reason: `couldn't load tape ${id}: ${e.message}`, added: [], removed: [] }; }

  const delivery = await readDatastore(DATA_DIR, DELIVERY_KEY, "stream_save");
  const dir = `${DATA_DIR}/tapes/${id}`;

  // Plan downloads: per track, the seekable .pdv + its .mp3 (best offline), or the
  // legacy .rwlpv if a tape predates scrubbable downloads. Skipped entirely when
  // delivery is "stream" (the user streams live). Always place manifest.json.
  const plan = [];
  const wantFile = (f, audio = false) => { if (f) plan.push({ file: f, url: `${base}/tapes/${id}/${f}`, audio }); };
  plan.push({ file: "manifest.json", url: null });
  if (placesLocal(delivery)) {
    for (const t of manifest.tracks || []) {
      if (t.pdv) { wantFile(t.pdv); wantFile(t.mp3, true); }
      else if (t.rwlpv) { wantFile(t.rwlpv); }
    }
  }
  // keep only files not already present (mp3 must clear the 1000-byte floor)
  const todo = [];
  for (const it of plan) {
    if (it.file === "manifest.json") { todo.push(it); continue; }
    const dest = `${dir}/${it.file}`;
    let have = await existsAsync(dest);
    if (have && it.audio) { try { have = (await fsp.stat(dest)).size > 1000; } catch { have = false; } }
    if (!have) todo.push(it);
  }

  // Prune: any OTHER tape folder (one-tape rule), demo excepted.
  const prune = [];
  try {
    for (const d of await fsp.readdir(`${DATA_DIR}/tapes`, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== id && d.name !== DEMO_ID) prune.push(d.name);
    }
  } catch { /* no tapes dir yet */ }

  const webData = { tapeId: id, tapeTitle: manifest.title || "" };
  if (dryRun) {
    return { ok: true, dryRun: true, tapeId: id, webData,
      added: todo.filter((t) => t.file !== "manifest.json").map((t) => t.file),
      removed: prune.map((d) => `tapes/${d}`),
      summary: `${manifest.title || id}: ${todo.length} files, ${prune.length} old tape(s) to clear` };
  }

  const added = [];
  for (const it of todo) {
    try {
      if (it.file === "manifest.json") { await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(`${dir}/manifest.json`, JSON.stringify(manifest)); continue; }
      onLog(`↓ ${it.file}`);
      const bytes = await downloadTo(it.url, `${dir}/${it.file}`);
      added.push(`${it.file} (${human(bytes)})`);
    } catch (e) { onLog(`  failed ${it.file}: ${e.message}`); }
  }
  const removed = [];
  for (const d of prune) {
    try { await fsp.rm(`${DATA_DIR}/tapes/${d}`, { recursive: true, force: true }); removed.push(`tapes/${d}`); onLog(`✗ cleared tape ${d}`); }
    catch { /* best effort */ }
  }

  const n = (manifest.tracks || []).length;
  return { ok: true, tapeId: id, webData,
    added, removed,
    summary: added.length || removed.length ? `${manifest.title || id} · +${added.length} / −${removed.length}` : `${manifest.title || id} ready · ${n} tracks` };
}

// "Open this mixtape on the web" link, once we know the tape id.
function webLink(config = {}) {
  return config.tapeId ? { url: `${WEB}/play/${config.tapeId}`, label: "Open this mixtape on the web →" } : null;
}

export default {
  id: "lilmixtape",
  name: "lilmixtape",
  bundleId: BUNDLE,
  detect: () => fs.existsSync(dataDirFor(BUNDLE)),
  sync,
  webLink,
};
