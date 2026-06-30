// Tomato Sync — Electron main process.
// A jontomato-branded companion that feeds MULTIPLE Playdate apps over USB. On
// connect it auto-detects which jontomato apps are on the device (folder-exists)
// and syncs each via its adapter, then stays "docked" (mounted) and re-syncs on a
// timer without ejecting (ejecting reboots the device). You eject in the morning.
// All sync logic is in ../src/engine.mjs (orchestrator) + ../src/adapters/*.

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerSaveBlocker, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
// Carry over config from the old single-app build (CrankcasterSync) if present.
const LEGACY_CONFIG = path.join(app.getPath("appData"), "crankcaster-sync", "config.json");
const DEFAULT_CONFIG = { autoSync: true, checkEveryMin: 2, apps: {}, knownApps: {} };

function loadConfig() {
  for (const p of [CONFIG_PATH, LEGACY_CONFIG]) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      // migrate a flat {code, stackId} (old build) into apps.crankcaster
      if (raw.code || raw.stackId) { raw.apps = { ...(raw.apps || {}), crankcaster: { code: raw.code, stackId: raw.stackId } }; delete raw.code; delete raw.stackId; }
      return { ...DEFAULT_CONFIG, ...raw, apps: { ...(raw.apps || {}) } };
    } catch { /* try next */ }
  }
  return { ...DEFAULT_CONFIG, apps: {} };
}
const saveConfig = (c) => { try { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); } catch {} };

// After an EJECT the device reboots and its port reappears — don't auto-redock on
// that for a bit (you ejected because you want to USE it). Manual sync still works.
const EJECT_COOLDOWN_MS = 5 * 60 * 1000;

let engine = null;
let config = loadConfig();
let tray = null, win = null, trayMenu = null;
let syncing = false, docked = false, dockTimer = null, psbId = null, cooldownUntil = 0;
let lastConnected = false;
const state = { status: "idle", connected: false, docked: false, lastSync: null, apps: {}, log: [] };

// Once an app has been detected on this Mac, remember it forever so its card +
// per-app Sync button are always there, even before the device reconnects (you
// shouldn't have to wait for a fresh detection to line up a sync). Seed from
// config.knownApps at launch; refresh as syncs happen.
for (const [id, info] of Object.entries(config.knownApps || {})) {
  state.apps[id] = { id, name: info.name || id, ok: true, summary: info.lastSummary || "Plug in to sync", lastSync: info.lastSync || null, remembered: true };
}

// Any adapter can expose webLink(config) → { url, label } (Crankcaster's "edit
// stack", lilmixtape's "open this mixtape"). Resolve them generically per app.
const appLink = (id) => {
  const a = engine && engine.byId && engine.byId(id);
  return a && a.webLink ? a.webLink((config.apps && config.apps[id]) || {}) : null;
};
const appLinks = () => Object.keys(state.apps).map((id) => { const l = appLink(id); return l ? { id, name: state.apps[id].name, ...l } : null; }).filter(Boolean);
const linksMap = () => Object.fromEntries(appLinks().map((l) => [l.id, { url: l.url, label: l.label }]));

// ── window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 680, show: false, resizable: true,
    title: "Tomato Sync", backgroundColor: "#fdfdfb",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}
const showWindow = () => { if (!win || win.isDestroyed()) createWindow(); win.show(); win.focus(); try { app.focus({ steal: true }); } catch {} };

// ── tray ─────────────────────────────────────────────────────────────────────
function trayIcon() {
  // macOS: black template image (auto-inverts on the menu bar). Windows/Linux: a
  // colored tomato (a black icon would vanish on the dark taskbar).
  const isMac = process.platform === "darwin";
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", isMac ? "tray.png" : "tray-win.png"));
  if (isMac && !img.isEmpty()) img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}
function statusLabel() {
  if (syncing) return state.status === "ejecting" ? "Ejecting…" : "Syncing…";
  if (docked) return "Docked — keeping in sync";
  if (state.connected) return "Ready";
  return "No Playdate";
}
function rebuildTray() {
  if (!tray) return;
  tray.setToolTip(`Tomato Sync — ${statusLabel()}`);
  const appItems = Object.values(state.apps).map((a) => ({
    label: `   ${a.name}: ${a.summary || (a.ok === false ? "needs attention" : "—")}`, enabled: false,
  }));
  const perAppSync = Object.values(state.apps).map((a) => ({
    label: `Sync ${a.name}`, enabled: !syncing && !!engine && (state.connected || docked), click: () => doSync("manual", true, false, a.id),
  }));
  const linkItems = appLinks().map((l) => ({ label: `${l.name}: ${l.label}`, click: () => shell.openExternal(l.url) }));
  trayMenu = Menu.buildFromTemplate([
    { label: `● ${statusLabel()}`, enabled: false },
    ...(appItems.length ? [{ type: "separator" }, ...appItems] : []),
    { type: "separator" },                 // — Open window in its own section —
    { label: "Open window", click: showWindow },
    ...(linkItems.length ? [{ type: "separator" }, ...linkItems] : []),   // — web links, own section —
    { type: "separator" },                 // — sync —
    { label: "Sync now (all apps)", enabled: !syncing && !!engine && (state.connected || docked), click: () => doSync("manual") },
    ...(perAppSync.length > 1 ? perAppSync : []),
    { type: "separator" },                 // — Eject in its own section —
    { label: "Eject (done for now)", enabled: !syncing && docked, click: () => doEject() },
    { type: "separator" },
    { label: "Auto-sync on connect", type: "checkbox", checked: config.autoSync, click: (mi) => { config.autoSync = mi.checked; saveConfig(config); } },
    { type: "separator" },
    { label: "Check for updates…", click: () => checkForUpdates(true) },
    { label: `Tomato Sync ${app.getVersion()}`, enabled: false },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(trayMenu);
}

const pushState = () => { state.docked = docked; if (win && !win.isDestroyed()) win.webContents.send("state", { ...state, config, syncing, links: linksMap() }); rebuildTray(); };
const pushLog = (line) => { state.log.push(line); if (state.log.length > 200) state.log.shift(); if (win && !win.isDestroyed()) win.webContents.send("log", line); };

// ── self-update check ─────────────────────────────────────────────────────────
// The app is unsigned, so we can't silently auto-install (mac needs a signed app
// for that). Instead: check the latest GitHub release and, if newer, offer to open
// the download page. `manual` shows an "up to date" / error dialog too.
const RELEASES_API = "https://api.github.com/repos/jnemargut/tomato-sync/releases/latest";
const RELEASES_PAGE = "https://github.com/jnemargut/tomato-sync/releases/latest";
const verNewer = (a, b) => { const A = a.split(".").map(Number), B = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((A[i] || 0) > (B[i] || 0)) return true; if ((A[i] || 0) < (B[i] || 0)) return false; } return false; };
async function checkForUpdates(manual = false) {
  try {
    const res = await fetch(RELEASES_API, { headers: { "User-Agent": "TomatoSync", Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const cur = app.getVersion();
    if (latest && verNewer(latest, cur)) {
      const r = await dialog.showMessageBox({ type: "info", message: "A new version of Tomato Sync is available", detail: `You have ${cur}. ${latest} is out. Open the download page?`, buttons: ["Download", "Later"], defaultId: 0, cancelId: 1 });
      if (r.response === 0) shell.openExternal(rel.html_url || RELEASES_PAGE);
    } else if (manual) {
      dialog.showMessageBox({ type: "info", message: "You're up to date", detail: `Tomato Sync ${cur} is the latest version.`, buttons: ["OK"] });
    }
  } catch (e) {
    if (manual) dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates", detail: String(e.message || e), buttons: ["OK"] });
  }
}

// ── keep the Mac awake while docked (so overnight checks run) ─────────────────
const startBlocker = () => { if (psbId === null) psbId = powerSaveBlocker.start("prevent-app-suspension"); };
const stopBlocker = () => { if (psbId !== null) { powerSaveBlocker.stop(psbId); psbId = null; } };

// ── dock re-check timer ──────────────────────────────────────────────────────
function startDockTimer() {
  if (dockTimer) return;
  const ms = Math.max(60 * 1000, (Number(config.checkEveryMin) || 2) * 60 * 1000);
  dockTimer = setInterval(() => doSync("auto", false, true), ms); // routine: cached fetch, quiet
}
function stopDockTimer() { if (dockTimer) { clearInterval(dockTimer); dockTimer = null; } }

// ── sync (mount if needed, run detected adapters, STAY docked) ───────────────
async function doSync(trigger, fresh = true, quiet = false, onlyApp = null) {
  if (syncing || !engine) return;
  if (!engine.isMounted() && !engine.deviceAwake()) { if (!quiet) pushLog(`(${trigger}) no Playdate connected`); return; }
  syncing = true; state.status = "syncing"; pushState();
  if (!quiet) pushLog(`— sync (${trigger}${onlyApp ? ": " + onlyApp : ""}) —`);
  try {
    if (!engine.isMounted()) {
      if (!(await engine.mountDevice(pushLog))) { pushLog("✗ couldn't mount — is the Playdate awake?"); state.status = "idle"; return; }
    }
    const res = await engine.syncMounted({ fresh, onlyApp, config: config.apps, onLog: pushLog });
    docked = true; startDockTimer(); startBlocker();
    state.status = "docked"; state.lastSync = Date.now();

    let changed = false;
    for (const a of res.apps || []) {
      const baseSummary = a.ok === false ? ("✗ " + (a.reason || "failed")) : (a.summary || "synced");
      const summary = a.appUpdated ? ("updated · " + baseSummary) : baseSummary;
      state.apps[a.id] = { id: a.id, name: a.name, ok: a.ok !== false, summary, lastSync: Date.now() };
      // remember this app so its card persists across restarts
      const ka = (config.knownApps ||= {});
      if (!ka[a.id] || ka[a.id].name !== a.name || ka[a.id].lastSummary !== summary) changed = true;
      ka[a.id] = { name: a.name, lastSummary: summary, lastSync: Date.now() };
      // remember each app's web-link data (Crankcaster code/stackId, lilmixtape
      // tapeId…) so the "open on the web" links survive restarts
      if (a.webData && a.ok !== false) { config.apps[a.id] = { ...(config.apps[a.id] || {}), ...a.webData }; changed = true; }
      if (a.added?.length || a.removed?.length) pushLog(`✓ ${a.name}: added ${a.added.length}, removed ${a.removed.length}`);
      else if (!quiet) pushLog(`✓ ${a.name}: up to date`);
    }
    if (changed) saveConfig(config);
    if (!(res.apps || []).length && !quiet) pushLog(res.reason === "no-known-apps" ? "no jontomato apps on this Playdate" : "nothing to sync");
  } catch (e) { state.status = docked ? "docked" : "idle"; pushLog("✗ error: " + e.message); }
  finally { syncing = false; pushState(); }
}

// ── eject (done for now) — device reboots back to normal use ─────────────────
async function doEject() {
  if (syncing || !engine) return;
  if (!engine.isMounted()) { docked = false; stopDockTimer(); stopBlocker(); pushState(); return; }
  syncing = true; state.status = "ejecting"; pushState();
  try { await engine.ejectDevice(pushLog); } catch (e) { pushLog("✗ eject: " + e.message); }
  docked = false; stopDockTimer(); stopBlocker();
  cooldownUntil = Date.now() + EJECT_COOLDOWN_MS;
  state.status = "idle"; syncing = false; pushState();
}

// ── device watcher ───────────────────────────────────────────────────────────
function startWatcher() {
  setInterval(() => {
    if (!engine) return;
    const mounted = engine.isMounted();
    const awake = engine.deviceAwake();
    const connected = mounted || awake;
    if (docked && !mounted) { docked = false; stopDockTimer(); stopBlocker(); state.status = "idle"; pushLog("Playdate disconnected"); } // unplugged
    if (awake && !mounted && !docked && config.autoSync && !syncing && Date.now() > cooldownUntil) doSync("on connect");
    if (connected !== lastConnected) { state.connected = connected; lastConnected = connected; pushState(); }
  }, 3000);
}

// ── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle("state:get", () => ({ ...state, config, syncing, links: linksMap() }));
ipcMain.handle("sync:now", () => doSync("manual"));
ipcMain.handle("sync:app", (_e, id) => doSync("manual", true, false, id));
ipcMain.handle("eject:now", () => doEject());
ipcMain.handle("open:link", (_e, id) => { const l = appLink(id); if (l) shell.openExternal(l.url); });
ipcMain.handle("config:set", (_e, patch) => {
  config = { ...config, ...patch }; saveConfig(config);
  if ("checkEveryMin" in patch && docked) { stopDockTimer(); startDockTimer(); }
  pushState(); return config;
});

// ── lifecycle ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    if (process.platform === "darwin" && app.dock) app.dock.hide();
    tray = new Tray(trayIcon());
    createWindow();
    rebuildTray();
    showWindow();
    try {
      engine = await import(pathToFileURL(path.join(__dirname, "..", "src", "engine.mjs")).href);
      state.connected = engine.deviceAwake() || engine.isMounted();
      pushLog("ready — connect your Playdate to sync");
    } catch (e) { pushLog("✗ failed to load sync engine: " + e.message); }
    startWatcher();
    pushState();
    setTimeout(() => checkForUpdates(false), 4000);   // quiet check shortly after launch
  });
  app.on("before-quit", () => { if (docked && engine && engine.isMounted()) { stopBlocker(); } });
  app.on("window-all-closed", () => { /* stay alive in the tray */ });
}
