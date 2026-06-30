#!/usr/bin/env node
// Tomato Sync — CLI. Thin wrapper over the orchestrator (src/engine.mjs).
// Syncs every jontomato app detected on the plugged-in, awake Playdate.
// Usage: node src/sync.mjs [--app crankcaster|rwlp] [--code XXXXX] [--dry]
import { runSync } from "./engine.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

console.log("Tomato Sync\n");
const res = await runSync({
  onlyApp: opt("--app", null),
  config: { crankcaster: { code: opt("--code", null) } },
  dryRun: args.includes("--dry"),
  onLog: (m) => console.log("  " + m),
});

if (!res.ok) {
  if (res.reason === "no-device") console.log("\n✗ No awake Playdate found. Wake it (lock button) + plug in, then re-run.");
  else console.log("\n✗ " + res.reason);
  process.exit(1);
}
if (!res.apps.length) { console.log(`\n(no known jontomato apps found on the device${res.reason ? `: ${res.reason}` : ""})`); process.exit(0); }

console.log("");
let totalAdd = 0, totalRem = 0;
for (const app of res.apps) {
  const add = app.added?.length || 0, rem = app.removed?.length || 0;
  totalAdd += add; totalRem += rem;
  console.log(`${app.name}: ${app.ok ? (app.summary || `+${add} / −${rem}`) : "✗ " + (app.reason || "failed")}`);
  if (res.dryRun) { (app.added || []).forEach((t) => console.log("  + " + t)); (app.removed || []).forEach((t) => console.log("  - " + t)); }
}
console.log(`\n✓ Done — ${res.apps.length} app(s), added ${totalAdd}, removed ${totalRem}.`);
