// Adapter registry. To teach Tomato Sync a new jontomato app, write one adapter
// module ({ id, name, bundleId, detect(), sync() }) and add it to this list.
import crankcaster from "./crankcaster.mjs";
import rwlp from "./rwlp.mjs";
import lilmixtape from "./lilmixtape.mjs";
import footnotes from "./footnotes.mjs";
import pourover from "./pourover.mjs";

export const adapters = [crankcaster, rwlp, lilmixtape, footnotes, pourover];
export const byId = (id) => adapters.find((a) => a.id === id) || null;

// Apps actually installed on the connected device right now (Decision 29:
// folder-exists detection at Data/<bundle>/).
export const detectedAdapters = () => adapters.filter((a) => a.detect());
