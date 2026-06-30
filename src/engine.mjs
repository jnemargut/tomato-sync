// Tomato Sync — orchestrator.
// Transport lives in core.mjs; per-app logic lives in adapters/*. This wires them:
// when the device is mounted, run every adapter whose app is installed, in turn.
// Mount / sync / eject stay separate so the app can keep the device "docked"
// (mounted) and re-sync over time without ejecting/rebooting between each pass.

import { mountDevice, ejectDevice, deviceAwake, isMounted, findPlaydatePort } from "./core.mjs";
import { adapters, byId, detectedAdapters } from "./adapters/index.mjs";
import { updateApps } from "./updater.mjs";

export { mountDevice, ejectDevice, deviceAwake, isMounted, findPlaydatePort, adapters, byId, detectedAdapters, updateApps };

// Sync every detected app (or just one, opts.onlyApp). Assumes the device is
// already mounted; does NOT eject. config is a per-app map: { crankcaster:{code,
// stackId}, rwlp:{} }. Returns { ok, apps:[{id,name,ok,added,removed,summary,…}] }.
export async function syncMounted(opts = {}) {
  const onLog = opts.onLog || (() => {});
  if (!isMounted()) return { ok: false, reason: "not-mounted", apps: [] };
  let found = detectedAdapters();
  if (opts.onlyApp) found = found.filter((a) => a.id === opts.onlyApp);
  if (!found.length) return { ok: true, apps: [], reason: opts.onlyApp ? "app-not-detected" : "no-known-apps" };

  // Update the apps THEMSELVES first (newer .pdx on R2 → swap it in), so the
  // content sync that follows runs against the latest build. Skippable + quiet
  // if no apps manifest is published. (opts.update === false turns it off.)
  let updates = { updated: [], checked: [] };
  if (opts.update !== false) {
    try { updates = await updateApps(found.map((a) => a.bundleId), { onLog, dryRun: opts.dryRun }); }
    catch (e) { onLog(`(app update check failed: ${e.message})`); }
  }

  const apps = [];
  for (const a of found) {
    if (found.length > 1 || !opts.quiet) onLog(`— ${a.name} —`);
    try {
      const r = await a.sync({
        fresh: opts.fresh, dryRun: opts.dryRun, onLog,
        config: (opts.config && opts.config[a.id]) || {},
      });
      apps.push({ id: a.id, name: a.name, ...r });
    } catch (e) {
      onLog(`✗ ${a.name}: ${e.message}`);
      apps.push({ id: a.id, name: a.name, ok: false, reason: e.message, added: [], removed: [] });
    }
  }
  // tag each app result with whether its .pdx was just updated
  for (const a of apps) {
    const ad = found.find((f) => f.id === a.id);
    a.appUpdated = !!(ad && updates.updated.some((u) => u.startsWith((ad.name) + " ") || u.startsWith(ad.name)));
  }
  return { ok: true, apps, updates };
}

// One-shot for the CLI: mount → sync all detected apps → eject.
export async function runSync(opts = {}) {
  const onLog = opts.onLog || (() => {});
  if (!(await mountDevice(onLog))) return { ok: false, reason: "no-device", apps: [] };
  const res = await syncMounted(opts);
  await ejectDevice(onLog);
  return res;
}
