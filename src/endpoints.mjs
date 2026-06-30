// Service endpoints. Real values are kept OUT of this repo: they come from env
// vars, or from an untracked endpoints.local.mjs that is present locally and in
// builds. The public source ships only empty placeholders.
let local = {};
try { local = (await import("./endpoints.local.mjs")).default || {}; } catch { /* absent in the public tree */ }
const pick = (env, key) => process.env[env] || local[key] || "";

export const APPS_MANIFEST   = pick("TOMATO_APPS_MANIFEST", "APPS_MANIFEST");
export const RWLP_HOST       = pick("TOMATO_RWLP_HOST", "RWLP_HOST");
export const LILMIXTAPE_HOST = pick("TOMATO_LILMIXTAPE_HOST", "LILMIXTAPE_HOST");
