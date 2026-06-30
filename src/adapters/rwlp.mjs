// Read Watch Listen Play adapter — the daily gift.
// RWLP drops one dated bundle per day on Cloudflare R2 (<YYYY-MM-DD>.json), which
// lists each pillar's asset path. The device writes them to bundles/<date>/<file>
// and shows today (keeping a 1-day grace). The companion (Decision 30 = B):
//   • fetch ONLY today's bundle,
//   • download only the pillars the user has set to download / stream_download
//     (skip stream / off — those are streamed on the device, saving big files),
//   • delete every OTHER bundle, the grace day included (the user can't reach it).
// "Downloaded" = file exists (audio must be > 1000 bytes). No device-app changes.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { dataDirFor, loadJson, existsAsync, downloadTo, fetchJson, human } from "../core.mjs";
import { RWLP_HOST } from "../endpoints.mjs";

const BUNDLE = "com.jontomato.readwatchlistenplay";
const base = `https://${RWLP_HOST}`;                          // content host (resolved from config)

// == Config.FILES: manifest field -> local filename inside bundles/<date>/
const FILES = {
  manifest: "manifest.json", read: "story.txt", readMeta: "story.json",
  readAudio: "read.mp3", readSync: "read.json", watch: "watch.pdv",
  watchMeta: "watch.json", watchAudio: "watch.mp3", watchImg: "watch.png",
  watchStream: "watch.rwlpv", listen: "listen.mp3", listenMeta: "listen.json",
  play: "crossword.json",
};

// Today's date as the device computes it: real US Eastern date (ET drop). Intl
// with America/New_York handles EDT/EST automatically; en-CA formats YYYY-MM-DD.
function todayET() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Settings live in a single Noble.Settings blob at Settings.json.
async function readSettings(DATA_DIR) { return (await loadJson(`${DATA_DIR}/Settings.json`, {})) || {}; }
const enabled = (s, p) => s[`enable_${p}`] !== false;        // default on
const modeOf = (s, p, dflt) => s[`mode_${p}`] || dflt;        // device defaults below
// "download" and "stream_download" both keep a local copy → the companion places them.
const placesLocal = (m) => m === "download" || m === "stream_download";

// A wanted asset: which manifest field, and whether it's audio (size-gated).
const want = (field, audio = false) => ({ field, file: FILES[field], audio });

async function sync({ dryRun = false, onLog = () => {} } = {}) {
  const DATA_DIR = dataDirFor(BUNDLE);   // resolve the device's data dir at run time
  const date = todayET();
  const dir = `${DATA_DIR}/bundles/${date}`;
  let manifest;
  try { manifest = await fetchJson(`${base}/${date}.json`); }
  catch (e) { return { ok: false, reason: `no drop for ${date}: ${e.message}`, added: [], removed: [] }; }

  const s = await readSettings(DATA_DIR);

  // Build the wanted-asset list from the manifest + the user's per-pillar modes.
  const wants = [want("manifest")];   // the device reads manifest.json off disk (note + asset refs)
  if (enabled(s, "read")) {
    wants.push(want("read"), want("readMeta"));                 // story text + meta: always (small)
    if (placesLocal(modeOf(s, "read", "off"))) wants.push(want("readAudio", true), want("readSync"));
  }
  if (enabled(s, "watch")) {
    wants.push(want("watchMeta"));
    const m = modeOf(s, "watch", "stream_download");
    // Download AND Stream+Save both keep the REAL film offline (.pdv + .mp3) so Watch
    // opens as the full scrubbable player with NO loading bar. The .rwlpv is only the
    // live-stream format — never what you pre-place. (Mirrors the device's own
    // Stream+Save prefetch, which also saves .pdv + .mp3, not .rwlpv — Sync.lua:608.)
    if (m === "download" || m === "stream_download") {
      if (manifest.watch) wants.push(want("watch"), want("watchAudio", true));     // film + soundtrack
      else wants.push(want("watchImg"));                                           // photo-essay day: save the still
    }
    // m === "stream" / "off": skip the film (device streams the .rwlpv live on open)
  }
  if (enabled(s, "listen")) {
    wants.push(want("listenMeta"));
    if (placesLocal(modeOf(s, "listen", "stream_download"))) wants.push(want("listen", true));
  }
  if (enabled(s, "play")) wants.push(want("play"));             // crossword: tiny

  // Diff vs disk: download a wanted asset only if the manifest has it and it isn't
  // already present (audio must clear the 1000-byte floor, matching the device).
  const plan = [];
  for (const w of wants) {
    const rel = manifest[w.field];
    if (!rel && w.field !== "manifest") continue;               // this pillar absent today
    const dest = `${dir}/${w.file}`;
    let have = await existsAsync(dest);
    if (have && w.audio) { try { have = (await fsp.stat(dest)).size > 1000; } catch { have = false; } }
    if (!have) plan.push({ ...w, url: w.field === "manifest" ? null : `${base}/${rel}` });
  }

  // Prune: every bundle dir that isn't today's (Decision 30 = today only).
  const prune = [];
  try {
    for (const d of await fsp.readdir(`${DATA_DIR}/bundles`, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== date) prune.push(d.name);
    }
  } catch { /* no bundles dir yet */ }

  // A leftover streaming-only watch.rwlpv in TODAY's bundle is dead weight once we
  // keep the real .pdv film (it's how an earlier sync mis-saved Stream+Save watch).
  const staleFiles = [];
  const wMode = modeOf(s, "watch", "stream_download");
  if (enabled(s, "watch") && (wMode === "download" || wMode === "stream_download") && manifest.watch
      && await existsAsync(`${dir}/${FILES.watchStream}`)) {
    staleFiles.push(FILES.watchStream);
  }

  if (dryRun) {
    return { ok: true, dryRun: true, date,
      added: plan.map((p) => p.file),
      removed: [...prune.map((d) => `bundles/${d}`), ...staleFiles.map((f) => `${date}/${f}`)],
      summary: `${plan.length} files for ${date}, ${prune.length} old bundle(s) + ${staleFiles.length} stale file(s) to clear` };
  }

  const added = [];
  for (const it of plan) {
    try {
      if (it.field === "manifest") {                            // write the manifest we already fetched
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(`${dir}/${it.file}`, JSON.stringify(manifest));
        added.push("manifest");
      } else {
        onLog(`↓ ${date}/${it.file}`);
        const bytes = await downloadTo(it.url, `${dir}/${it.file}`);
        added.push(`${it.file} (${human(bytes)})`);
      }
    } catch (e) { onLog(`  failed ${it.file}: ${e.message}`); }
  }
  const removed = [];
  for (const d of prune) {
    try { await fsp.rm(`${DATA_DIR}/bundles/${d}`, { recursive: true, force: true }); removed.push(`bundles/${d}`); onLog(`✗ cleared ${d}`); }
    catch { /* best effort */ }
  }
  for (const f of staleFiles) {
    try { await fsp.rm(`${dir}/${f}`, { force: true }); removed.push(`${date}/${f}`); onLog(`✗ removed redundant ${f}`); }
    catch { /* best effort */ }
  }

  const pillars = ["read", "watch", "listen", "play"].filter((p) => enabled(s, p) && manifest[p === "play" ? "play" : p]);
  return { ok: true, date, added, removed,
    summary: added.length || removed.length ? `Today (${date}) · +${added.length} / −${removed.length}` : `Today's gift ready · ${date}`,
    pillars };
}

export default {
  id: "rwlp",
  name: "Read Watch Listen Play",
  bundleId: BUNDLE,
  detect: () => fs.existsSync(dataDirFor(BUNDLE)),
  sync,
};
