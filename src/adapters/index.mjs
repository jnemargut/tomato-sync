// Adapter registry. To teach Tomato Sync a new jontomato app, write one adapter
// module ({ id, name, bundleId, detect(), sync() }) and add it to this list.
import crankcaster from "./crankcaster.mjs";
import rwlp from "./rwlp.mjs";
import lilmixtape from "./lilmixtape.mjs";

export const adapters = [crankcaster, rwlp, lilmixtape];
export const byId = (id) => adapters.find((a) => a.id === id) || null;

// Apps actually installed on the connected device right now (Decision 29:
// folder-exists detection at Data/<bundle>/).
export const detectedAdapters = () => adapters.filter((a) => a.detect());
