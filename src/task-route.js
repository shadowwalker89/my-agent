// Backward-compatible shim (R0.6). Task/combo routing now lives in
// src/pipeline/route.js. New code should import from there; this entry point
// stays so src/index.js and scripts/test-combos.mjs keep working unchanged.
// Output of classifyTask is one of: "vision" | "code" | "chat" — when in doubt, "chat".
export { updateHasImage, BUILTIN_COMBOS, comboCandidates, fallbackCombo, selectCombo, classifyTask } from "./pipeline/route.js";
