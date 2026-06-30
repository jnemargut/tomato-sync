// Crankcaster adapter — podcasts via a stack code.
// Reads the device's stack, fetches the latest manifest, downloads the newest
// UNPLAYED episodes per the device's own keep-count/mode, and prunes anything the
// device is done with. The diff keys off ONE date-ordered target set so downloads
// and eviction can never disagree (no churn). Behavior is unchanged from the
// single-app engine — this is the same logic, now wearing the adapter interface.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { dataDirFor, loadJson, existsAsync, downloadTo, fetchJson, pdNow, human } from "../core.mjs";

const SERVER = "https://crankcaster.com";
const BUNDLE = "com.jontomato.crankcaster";

const sanitize = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "_"); // == storage.lua
const pkey = (pid, ep) => `${pid}|${ep}`;

async function readDeviceManifest(DATA_DIR) {
  const m = await loadJson(`${DATA_DIR}/crankcast_manifest.json`, null);
  return m && m.podcasts ? m : null;
}

async function sync({ fresh = true, dryRun = false, onLog = () => {}, config = {} } = {}) {
  const DATA_DIR = dataDirFor(BUNDLE);   // resolve the device's data dir at run time
  const codeArg = config.code || null;
  const fq = fresh ? "?fresh=1" : "";
  const dev = await readDeviceManifest(DATA_DIR);
  let manifest;
  try {
    const code = codeArg || dev?.code;
    if (code) manifest = await fetchJson(`${SERVER}/api/code/${encodeURIComponent(code)}${fq}`);
    else if (dev?.stackId) manifest = await fetchJson(`${SERVER}/api/manifest/${encodeURIComponent(dev.stackId)}${fq}`);
    else throw new Error("no code and no stack on the device");
  } catch (e) {
    if (!dev) return { ok: false, reason: "no-stack: " + e.message, added: [], removed: [] };
    onLog(`using device's saved manifest (server fetch failed: ${e.message})`);
    manifest = dev;
  }

  const storage   = await loadJson(`${DATA_DIR}/crankcast_storage.json`, {});
  const played    = await loadJson(`${DATA_DIR}/crankcast_played.json`, {});
  const dismissed = await loadJson(`${DATA_DIR}/crankcast_dismissed.json`, {});
  const removed   = await loadJson(`${DATA_DIR}/crankcast_removed.json`, {});
  const settings  = await loadJson(`${DATA_DIR}/crankcast_settings.json`, {});
  const isDone = (pid, ep) => played[pkey(pid, ep)] || dismissed[pkey(pid, ep)];

  // Single source of truth: per show, the newest `keepCount` UNPLAYED episode ids
  // in the manifest's date order. Both downloads and eviction key off this set.
  const targetIds = {};
  for (const show of manifest.podcasts) {
    if (removed[show.id]) continue;
    const st = settings[show.id] || {};
    let keep = st.keepCount ?? 3;
    if ((st.mode || "download") === "stream") keep = 0;
    keep = Math.max(0, Math.min(5, keep));
    if (keep === 0) continue;
    const want = new Set();
    for (const ep of show.episodes || []) {
      if (want.size >= keep) break;
      if (isDone(show.id, ep.id)) continue;
      want.add(ep.id);
    }
    targetIds[show.id] = want;
  }

  // adds: targeted episodes not yet on disk
  const plan = [];
  let skipped = 0;
  for (const show of manifest.podcasts) {
    const want = targetIds[show.id];
    if (!want) continue;
    const have = storage[show.id] || {};
    for (const ep of show.episodes || []) {
      if (!want.has(ep.id)) { if (isDone(show.id, ep.id)) skipped++; continue; }
      const rel = `keep/${sanitize(show.id)}/${sanitize(ep.id)}.mp3`;
      const onDisk = have[ep.id]?.path && (await existsAsync(`${DATA_DIR}/${have[ep.id].path}`));
      if (!onDisk) plan.push({ show, ep, rel });
    }
  }

  // removals: anything on disk that isn't wanted and isn't pinned (covers played,
  // beyond-keep, and removed-on-web). Pinned on-demand picks are always spared.
  const prunePlan = [];
  for (const showId of Object.keys(storage)) {
    const want = targetIds[showId] || new Set();
    for (const [epId, r] of Object.entries(storage[showId])) {
      if (!r || !r.path) continue;
      if (want.has(epId)) continue;
      if (r.pinned) continue;
      prunePlan.push({ showId, epId, rel: r.path });
    }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, stack: manifest.code, stackId: manifest.stackId, version: manifest.version,
      added: plan.map((p) => `${p.show.title} — ${p.ep.t}`), removed: prunePlan.map((p) => p.epId), skipped,
      summary: `${plan.length} to add, ${prunePlan.length} to remove` };
  }

  const added = [];
  for (const it of plan) {
    onLog(`↓ ${it.show.title} — ${it.ep.t}`);
    try {
      const bytes = await downloadTo(it.ep.mp3, `${DATA_DIR}/${it.rel}`);
      (storage[it.show.id] ||= {})[it.ep.id] = { path: it.rel, bytes, finished: false, pinned: false, ts: pdNow() };
      added.push(`${it.show.title} — ${it.ep.t} (${human(bytes)})`);
    } catch (e) { onLog(`  failed: ${e.message}`); }
  }
  const removedList = [];
  for (const it of prunePlan) {
    try { if (it.rel) await fsp.rm(`${DATA_DIR}/${it.rel}`, { force: true }); } catch { /* best effort */ }
    if (storage[it.showId]) delete storage[it.showId][it.epId];
    removedList.push(`${it.showId}/${it.epId}`);
  }

  // GC untracked .mp3 files (invisible to the app, pure dead weight).
  try {
    const tracked = new Set();
    for (const sid of Object.keys(storage)) for (const eid of Object.keys(storage[sid] || {})) { const p = storage[sid][eid]?.path; if (p) tracked.add(p); }
    const keepRoot = `${DATA_DIR}/keep`;
    for (const d of await fsp.readdir(keepRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of await fsp.readdir(`${keepRoot}/${d.name}`)) {
        if (!f.endsWith(".mp3")) continue;
        const rel = `keep/${d.name}/${f}`;
        if (tracked.has(rel)) continue;
        try { await fsp.rm(`${keepRoot}/${d.name}/${f}`, { force: true }); onLog(`✗ orphan file ${rel}`); removedList.push(`orphan:${rel}`); } catch { /* best effort */ }
      }
    }
  } catch { /* no keep dir yet */ }

  if (added.length || removedList.length) await fsp.writeFile(`${DATA_DIR}/crankcast_storage.json`, JSON.stringify(storage));

  const shows = manifest.podcasts?.length || 0;
  return { ok: true, stack: manifest.code, stackId: manifest.stackId, version: manifest.version,
    webData: { code: manifest.code, stackId: manifest.stackId },
    added, removed: removedList, skipped, summary: added.length || removedList.length ? `+${added.length} / −${removedList.length}` : `Up to date · ${shows} shows` };
}

// "Edit stack on the web" link. The editable page is the secret /s/<id>; the code
// only opens a read view.
function webLink(config = {}) {
  if (config.stackId) return { url: `${SERVER}/s/${config.stackId}`, label: "Edit stack on the web →" };
  if (config.code) return { url: `${SERVER}/c/${config.code}`, label: "View stack on the web →" };
  return null;
}

export default {
  id: "crankcaster",
  name: "Crankcaster",
  bundleId: BUNDLE,
  detect: () => fs.existsSync(dataDirFor(BUNDLE)),
  sync,
  webLink,
};
