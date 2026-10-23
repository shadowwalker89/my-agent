import { readFileSync } from "node:fs";

const TG_API = "https://api.telegram.org";

function readDevVars() {
  let content;
  try {
    content = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  } catch {
    console.error("Could not read .dev.vars — copy .dev.vars.example to .dev.vars first.");
    process.exit(1);
  }

  const vars = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const { TG_TOKEN, TG_SECRET } = readDevVars();
if (!TG_TOKEN || !TG_SECRET) {
  console.error(".dev.vars must contain TG_TOKEN and TG_SECRET.");
  process.exit(1);
}

const args = process.argv.slice(2);
const infoMode = args.includes("--info");
const url = args.find((a) => a !== "--info");

if (!infoMode && !url) {
  console.error("Usage: node scripts/set-webhook.mjs <worker-url>/telegram   (or: --info)");
  process.exit(1);
}

if (!infoMode && !/^https:\/\//.test(url)) {
  console.error("Webhook URL must start with https://");
  process.exit(1);
}

const method = infoMode ? "getWebhookInfo" : "setWebhook";
const body = infoMode
  ? {}
  : { url, secret_token: TG_SECRET, allowed_updates: ["message"], drop_pending_updates: true };

try {
  const res = await fetch(`${TG_API}/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
  if (!json.ok) process.exit(1);
} catch (err) {
  console.error("Request to Telegram failed:", err);
  process.exit(1);
}
