export async function uploadToUploadAm(bytes, filename, { apiKey, fetchFn } = {}) {
  const f = fetchFn ?? globalThis.fetch;
  if (typeof f !== "function") return { ok: false, error: "fetch unavailable" };
  try {
    const form = new FormData();
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes ?? ""], { type: "application/octet-stream" });
    form.append("file", blob, filename || "file.bin");
    if (apiKey) { form.append("api_key", String(apiKey)); form.append("key", String(apiKey)); }
    const res = await f("https://upload.am/api/upload", {
      method: "POST",
      body: form,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
    let data = null;
    try { data = typeof res?.json === "function" ? await res.json() : res; } catch {}
    const url = data?.url ?? data?.link ?? data?.file_url ?? data?.download_url ?? data?.data?.url ?? null;
    if (url) return { ok: true, url };
    if (res?.ok && data && typeof data === "object") return { ok: true, url: null, data };
    return { ok: false, error: data?.error ?? data?.message ?? `upload failed${res?.status ? ` ${res.status}` : ""}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}



