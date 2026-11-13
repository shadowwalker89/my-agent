export const failures = [];
let checks = 0;
export function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}

export function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

// ── mock world (telegram + github + unexpected) ────────────────────────────
export function mockWorld({ prFiles = [], ciState = "success", ciTargetUrl = "https://ci.example/run/1", ciRuns = [{ status: "completed", conclusion: "success", html_url: "https://runs.example/1", head_sha: "headsha123", run_number: 12, event: "push", created_at: "2026-01-01T00:00:00Z" }], runsForbidden = false, ciRunsStatus = 200, prState = "open", prMerged = false, prMissing = false } = {}) {
  const calls = { telegram: [], github: [], unexpected: 0 };
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      const m = /\/bot[^/]+\/(\w+)$/.exec(u);
      let payload = {};
      try {
        payload = JSON.parse(String(init.body ?? "{}"));
      } catch {}
      calls.telegram.push({ method: m ? m[1] : "", payload });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (u.startsWith("https://api.github.com/")) {
      const method = String(init.method ?? "GET").toUpperCase();
      let body = null;
      try {
        body = init.body ? JSON.parse(String(init.body)) : null;
      } catch {}
      calls.github.push({ method, url: u, body });
       if (u.includes("/actions/workflows/ci.yml/runs") && method === "GET") {
         if (runsForbidden) return new Response("", { status: 403 });
         if (ciRunsStatus && ciRunsStatus !== 200) return new Response("", { status: ciRunsStatus });
         return Response.json({ workflow_runs: ciRuns });
       }
      if (u.includes("/actions/workflows/")) return new Response(null, { status: 204 });
      if (/\/pulls\/\d+\/files/.test(u)) return Response.json(prFiles);
      if (/\/pulls\/\d+\/merge$/.test(u) && method === "PUT") {
        return Response.json({ sha: "deadbeef", merged: true });
      }
      if (/\/commits\/[^/]+\/status$/.test(u) && method === "GET") {
        if (ciState === "forbidden") return new Response("", { status: 403 });
        if (ciState === "error") return new Response("", { status: 500 });
        return Response.json({
          state: ciState === "missing" ? "pending" : ciState,
          statuses: ciState === "missing" ? [] : [{ context: "ci/offline-checks", state: ciState, target_url: ciTargetUrl }],
        });
      }
      if (prMissing) {
        // handled below by status check
      }
      if (/\/pulls\/\d+$/.test(u) && method === "GET") {
        if (prMissing) return new Response("", { status: 404 });
        return Response.json({
          state: prState,
          merged: prMerged,
          merged_at: prMerged ? "2026-01-01T00:00:00Z" : null,
          number: 7,
          head: { ref: "opencode/dispatch-abc-123", sha: "headsha123" },
          html_url: "https://github.com/shadowwalker89/my-agent/pull/7",
        });
      }
      if (/\/pulls\/\d+$/.test(u) && method === "PATCH") return Response.json({ state: "closed" });
      if (u.includes("/git/refs/heads/") && method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 200 });
    }
    calls.unexpected += 1;
    return new Response(JSON.stringify({ error: { message: "unexpected fetch" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (global.fetch = orig) };
}

export const workerDefault = (await import("../../src/index.js")).default;
export const ctxNull = {};

export async function sendTg(env, update) {
  const pending = [];
  const res = await workerDefault.fetch(
    new Request("https://test.local/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.TG_SECRET },
      body: JSON.stringify(update),
    }),
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  check(res.status === 200, `/telegram باید 200 بدهد (${res.status})`);
  await Promise.all(pending);
}

// Phase 2-d: webhook updates carry globally unique, increasing ids in
// production, so the factories allocate a fresh id per update (the old
// fixed 1/2 collided with handleUpdate's update_id dedup: after the
// first scenario, every later scenario was ignored as a redelivery).
// No test posts the same update twice, so no assertion changes.
let nextTestUpdateId = 100000;
export function msgUpdate(text, userId = 4242) {
  return {
    update_id: nextTestUpdateId++,
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1000),
      from: { id: userId, is_bot: false, first_name: "T" },
      chat: { id: userId, type: "private" },
      text,
    },
  };
}

export function cbUpdate(data, userId = 4242) {
  return {
    update_id: nextTestUpdateId++,
    callback_query: {
      id: "cb-1",
      from: { id: userId, is_bot: false, first_name: "T" },
      message: { message_id: 11, chat: { id: userId, type: "private" } },
      data,
    },
  };
}

export function newEnv(extra = {}) {
  return {
    STATE: fakeKV(),
    TG_TOKEN: "fake-token",
    TG_SECRET: "fake-tg-secret",
    ALLOWED_TG_IDS: "4242",
    ...extra,
  };
}

export let DatabaseSync = null;
try { DatabaseSync = (await import('node:sqlite').catch(() => ({}))).DatabaseSync; } catch {}
if (!DatabaseSync) {
  if (process.env.REQUIRE_SQLITE === "1") throw new Error("DatabaseSync (node:sqlite) is required when REQUIRE_SQLITE=1");
  console.warn("\u26a0 node:sqlite در دسترس نیست \u2014 تست‌های ۱الف رد شد.");
}
export const getChecks = () => checks;
