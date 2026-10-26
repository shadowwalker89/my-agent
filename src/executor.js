// اجراکننده‌ی task — رابط پایدار برای backendهای آینده.
// runTask(env, spec) -> Promise<{ ok, text, code? }>
//
// spec: { kind: "task", prompt: string, chatId?, userId? }
//
// رفتار پیش‌فرض: backend تنظیم نشده → { ok: false, code: "not_configured" }.
// backend از env.EXECUTOR انتخاب می‌شود (نام رشته‌ای)؛ هیچ مقدار راز لاگ نمی‌شود.
// افزودن backend جدید فقط داخل همین فایل انجام می‌شود تا index.js دست‌نخورده بماند.

export const EXECUTOR_NOT_CONFIGURED =
  "اجراکننده‌ی task پیکربندی نشده.\nThe task executor is not configured.";

export const EXECUTOR_UNSUPPORTED =
  "این نوع task پشتیبانی نمی‌شود.\nThis task kind is not supported.";

const BACKENDS = Object.freeze({
  // آینده: "freestyle": (env, spec) => import("./executor-freestyle.js").then((m) => m.run(env, spec)),
});

function normalizeSpec(spec) {
  const src = spec && typeof spec === "object" ? spec : {};
  return {
    kind: typeof src.kind === "string" ? src.kind.trim().toLowerCase() : "task",
    prompt: typeof src.prompt === "string" ? src.prompt : "",
    chatId: src.chatId ?? null,
    userId: src.userId ?? null,
  };
}

export async function runTask(env, spec) {
  const input = normalizeSpec(spec);
  if (input.kind !== "task") {
    return { ok: false, code: "unsupported_kind", text: EXECUTOR_UNSUPPORTED };
  }
  if (!input.prompt.trim()) {
    return { ok: false, code: "empty_prompt", text: "پرامپت خالی است.\nEmpty prompt." };
  }

  const backendName = typeof env?.EXECUTOR === "string" ? env.EXECUTOR.trim() : "";
  const backend = backendName && Object.prototype.hasOwnProperty.call(BACKENDS, backendName)
    ? BACKENDS[backendName]
    : null;

  if (!backend) {
    return { ok: false, code: "not_configured", text: EXECUTOR_NOT_CONFIGURED };
  }

  try {
    const result = await backend(env, input);
    if (!result || typeof result !== "object") {
      return { ok: false, code: "bad_backend_result", text: "اجراکننده پاسخ نامعتبر داد.\nThe executor returned an invalid result." };
    }
    return {
      ok: result.ok === true,
      code: result.code ?? (result.ok === true ? undefined : "backend_failed"),
      text: typeof result.text === "string" ? result.text : "",
    };
  } catch {
    return { ok: false, code: "backend_error", text: "اجراکننده با خطا متوقف شد.\nThe executor failed." };
  }
}
