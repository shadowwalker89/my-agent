// KV key "overrides:v1": { pins: { combo: ["provider/model", ...] }, bans: ["provider/model"],
// prefer: { combo: ["regex", ...] } }
const KEY = "overrides:v1";
const EMPTY = { pins: {}, bans: [], prefer: {} };

export async function getOverrides(env) {
  if (!env.STATE) return { pins: {}, bans: [], prefer: {} };
  const v = await env.STATE.get(KEY, "json");
  return {
    pins: v?.pins ?? EMPTY.pins,
    bans: v?.bans ?? EMPTY.bans,
    prefer: v?.prefer ?? EMPTY.prefer,
  };
}

async function setOverrides(env, ov) {
  await env.STATE.put(KEY, JSON.stringify(ov));
  return ov;
}

export async function addPin(env, combo, target) {
  const ov = await getOverrides(env);
  const list = ov.pins[combo] ?? [];
  if (!list.some((t) => t.toLowerCase() === target.toLowerCase())) list.push(target);
  ov.pins[combo] = list;
  return setOverrides(env, ov);
}

export async function removePin(env, combo, target) {
  const ov = await getOverrides(env);
  const list = (ov.pins[combo] ?? []).filter((t) => t.toLowerCase() !== target.toLowerCase());
  if (list.length) ov.pins[combo] = list;
  else delete ov.pins[combo];
  return setOverrides(env, ov);
}

export async function addBan(env, target) {
  const ov = await getOverrides(env);
  if (!ov.bans.some((t) => t.toLowerCase() === target.toLowerCase())) ov.bans.push(target);
  return setOverrides(env, ov);
}

export async function removeBan(env, target) {
  const ov = await getOverrides(env);
  ov.bans = ov.bans.filter((t) => t.toLowerCase() !== target.toLowerCase());
  return setOverrides(env, ov);
}

export async function setPrefer(env, combo, patterns) {
  const ov = await getOverrides(env);
  if (patterns === null) delete ov.prefer[combo];
  else ov.prefer[combo] = patterns;
  return setOverrides(env, ov);
}

// pin ها را روی کاتالوگ حل می‌کند؛ pin های گمشده (قدیمی) بی‌صدا می‌افتند (health جدا چک می‌شود).
export function resolvePins(pinTargets, catalog) {
  const found = [];
  for (const t of pinTargets ?? []) {
    const entry = catalog.find((m) => `${m.provider}/${m.id}`.toLowerCase() === String(t).toLowerCase());
    if (entry) found.push(entry);
  }
  return found;
}

export function validatePattern(pattern) {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}
