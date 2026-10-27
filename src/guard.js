// Shared path guard — used by the Worker (approve check) and by the
// opencode-dev workflow (pre-merge check). Keep the two callers on this module.
//
// Protected paths are human-only. Patterns intentionally use prefixes for
// `.env*` / `.dev.vars*` so variants are blocked too.

export const PROTECTED_PATTERNS = Object.freeze([
  /^\.github\//i,
  /^opencode\.json$/i,
  /^wrangler\.(?:json|jsonc|toml)$/i,
  /^\.dev\.vars/i,
  /^\.env/i,
  /^package-lock\.json$/i,
]);

export function normalizeGuardPath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

export function isProtectedPath(path) {
  const s = normalizeGuardPath(path);
  if (!s) return false;
  return PROTECTED_PATTERNS.some((re) => re.test(s));
}
