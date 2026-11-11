# ممیزی عمیق my-agent (فقط‌خواندنی)

تاریخ: ۱۱ نوامبر ۲۰۲۶ — دامنه: `src/` (Cloudflare Worker + D1 + KV + Telegram). هیچ فایل کدی تغییر نکرده است.
شماره‌خط‌ها مربوط به وضعیت فعلی مخزن هستند.

---

## ۱. باگ‌های بحرانی

| # | فایل:خط | مشکل | اثر |
|---|---------|------|-----|
| C1 | `src/router.js:478` | `env.STATE.put("rr:<combo>")` در هر درخواست round-robin | سقف ۱۰۰۰ نوشتن KV در روز (Free) سریع پر می‌شود؛ بعد از آن همه‌ی `put`ها خطا می‌دهند (health، draft، pending ask). |
| C2 | `src/media.js:675` | `geminiKey.startsWith("AIza") ? undefined : timeoutSignal(4000)` — منطق برعکس است | کلیدهای واقعی Gemini همیشه با `AIza` شروع می‌شوند، پس vision جمینای **هیچ timeout ندارد** و می‌تواند از سقف ۳۰ ثانیه‌ی `waitUntil` رد شود → پاسخ بی‌صدا گم می‌شود. |
| C3 | `src/media.js:326-338` | POST در صورت 404 به `${base}/call/infer` می‌رود، اما GET استریم SSE همیشه `${base}/gradio_api/call/infer/<id>` است | در Spaceهای Gradio قدیمی همیشه `hf-space:no_complete` و تلف شدن ۲۴ ثانیه. |
| C4 | `src/media.js:586` و `:608` | `editImage` روی هیچ‌کدام از fetchها `signal` ندارد | ویرایش تصویر می‌تواند بی‌نهایت معطل بماند. |
| C5 | `src/media.js:608-611` | «ویرایش» با `FLUX.1-schnell` روی `api-inference.huggingface.co` | این مدل text-to-image است و فیلد `image` را نادیده می‌گیرد؛ خروجی یک تصویر کاملاً جدید است، نه ویرایش. endpoint هم منسوخ شده (`router.huggingface.co/hf-inference`). |
| C6 | `src/everyday.js:2088` و `:2002` | `"\\n"` داخل template literal | کاربر عبارت `\n` را به‌صورت متن خام می‌بیند؛ پرامپت Gemini هم `\n` خام می‌گیرد. |
| C7 | `src/everyday.js:2090`، `:2527` | `**bold**` با `mdEscape` در حالی که `tgSend` HTML است | ستاره‌ها خام نمایش داده می‌شوند. باید `<b>${escapeHtml(x)}</b>` باشد. |
| C8 | `src/index.js:1079-1084` | dedup روی `update_id` فقط در حافظه‌ی isolate | تحویل دوباره از سوی تلگرام به isolate دیگر → یادداشت/تسک/هزینه‌ی تکراری. |
| C9 | `src/everyday.js:1998-2000` | ساخت base64 با `bin += String.fromCharCode` بایت‌به‌بایت | O(n²) و مصرف CPU بالا برای عکس ۱–۵ مگابایتی؛ ریسک رسیدن به سقف CPU در Free (۱۰ms). `bytesToBase64` آماده در `pdf.js:3`/`media.js:39` هست. |
| C10 | `src/media.js:639-731` | بودجه‌ی vision جمع نمی‌شود: router 20s + Gemini (بدون سقف) + NVIDIA 3×12s | در بدترین حالت بیش از ۶۰ ثانیه، که از سقف ۳۰ ثانیه‌ی `waitUntil` خیلی بیشتر است. |
| C11 | `src/telegram.js:3` | `tgApi` نه `res.ok` را بررسی می‌کند و نه timeout دارد | قطعی API تلگرام کل نوبت را معطل می‌کند. |

---

## ۲. ضعف‌ها و اصلاح‌های مشخص

### ۲.۱ مفسر معنایی (Semantic pipeline)

**وضعیت فعلی** (`src/everyday.js:2496-2712`): ترتیب بررسی این است: reply-photo → regex ساخت تصویر → regex ساخت PDF → نام‌گذاری فایل vault → `classifyDaily` (regex). هر intent غیر از `chat`/`ask` **مستقیم** به `viaBranch` می‌رود (`:2712`). AI فقط وقتی فرصت دارد که regex چیزی پیدا نکند یا heuristic `greedyShouldDeferToAi` (`:2707`) فعال شود.

**ضعف‌ها:**
- regex مقدم بر مدل است، پس خطای regex (false positive) هرگز اصلاح نمی‌شود. مثال: «یادم بنداز اسمم چی بود» با الگوی reminder گرفته می‌شود.
- `isRef = /همونو|همون|اونو|اینو/` (`:2317`) مرز کلمه ندارد؛ مثلاً «همونجا» هم match می‌شود.
- `runNluBranch` در هر نوبت ۳ تا ۴ کوئری D1 اجرا می‌کند (`resolveProjects`، `listOpenTasks`، `listNotes`، `resolveFolderTag`) قبل از اینکه بداند لازم است.
- `classifyIntent` (`src/intent.js:266`) بر اساس *نوع آرگومان* دو API کاملاً متفاوت دارد؛ شکننده است و `index.js:852` نسخه‌ی legacy را صدا می‌زند.

**اصلاح پیشنهادی:**
```js
// everyday.js: regex فقط «کاندید» تولید کند؛ قطعی‌ها مستقیم، بقیه به مدل
const STRICT = new Set(["expense", "income", "task-list", "command"]);
if (STRICT.has(c.intent) && c.confidence >= 1) return viaBranch(c);
if (aiAvailableForNlu) { const r = await runNluBranch(env, o, { ...ctx, ruleHint: c }); if (r) return r; }
if (c.intent !== "chat" && c.intent !== "ask") return viaBranch(c);
```
```js
const REF_RE = /(?:^|\s)(همونو|همون|اونو|اینو)(?=\s|$)/u;
```
- `classifyIntent` به دو export جدا تقسیم شود: `classifyIntentLegacy` و `classifyIntentNlu`.
- `listOpenTasks`/`listNotes` فقط وقتی اجرا شوند که `REF_RE.test(text)` درست باشد.

### ۲.۲ حافظه و وابستگی پیام‌ها

- `src/memory.js`: کانتکست چت فقط از سطرهای `kind='chat'` ساخته می‌شود. پس اقدام‌های daily (یادداشت، تسک، هزینه) در تاریخچه‌ی مدل دیده نمی‌شوند و سؤال «آخرین تسکم چی بود؟» بدون زمینه می‌ماند.
- `src/index.js:819-823`: از `reply_to_message` فقط **عکس** خوانده می‌شود. ریپلای به یک پیام متنی، یا به سند/تصویری که به‌صورت document فرستاده شده، کاملاً نادیده گرفته می‌شود و هیچ وابستگی بین پیام‌ها ثبت نمی‌شود.
- `src/index.js:1133-1134`: `chatFn` در مسیر فایل بدون system prompt و بدون memory header است، پس تحلیل PDF شخصی‌سازی نمی‌شود.

**اصلاح:**
```js
// index.js handlePlainText
const replyText = typeof replyMsg?.text === "string" ? replyMsg.text.slice(0, 1500) : null;
const replyDoc = replyMsg?.document?.mime_type?.startsWith("image/") ? replyMsg.document : null;
const modelText = replyText ? `[در پاسخ به: «${replyText}»]\n${text}` : text;
```
- یک ستون `reply_to_tg_msg_id` به جدول `messages` اضافه شود. `buildChatContext` پیام والد را حتی اگر خارج از پنجره‌ی ۵۰تایی باشد اضافه کند.
- خلاصه‌ی یک‌خطی اقدام‌های daily (`kind='daily'`) هم به‌صورت system note وارد کانتکست شود، بدون مقادیر حساس.

### ۲.۳ تصویر (ساخت، ویرایش، vision)

- یک تابع مشترک `withBudget(deadlineMs)` بسازید که هر fetch را با `AbortSignal.timeout(Math.min(step, deadline - Date.now()))` اجرا کند. یک deadline کلی حدود ۲۴ ثانیه برای کل `analyzeImage`/`generateFreeImage`/`editImage` کافی است.
- اصلاح C2:
```js
const geminiSignal = timeoutSignal(Math.min(9000, remaining()));
```
- اصلاح C3:
```js
let callPath = "/gradio_api/call/infer";
let post = await postInfer(base + callPath);
if (post?.status === 404) { callPath = "/call/infer"; post = await postInfer(base + callPath); }
const sse = await fetchFn(`${base}${callPath}/${eventId}`, ...);
```
- کلید Gemini به‌جای query string در هدر `x-goog-api-key` فرستاده شود (`media.js:292,501,586,678` و `everyday.js:2006`). این کار احتمال نشت کلید در لاگ یا پیام خطا را از بین می‌برد.
- `everyday.js:1993` (`analyzeVaultImage`) تکرار `analyzeImage` است و باید حذف شود و فقط `analyzeImage` بماند.
- `isImageEditCaption` (`media.js:569`): نشانگرهای «رنگ»، «تغییر» و «حذف» خیلی کلی‌اند. مثلاً «رنگ این ماشین چیه؟» به‌عنوان ویرایش تشخیص داده می‌شود. پیشنهاد: اول `isVisionQuestionCaption` بررسی شود، سپس ویرایش.
- در NVIDIA، پرامپت دو بار تکرار شده است (`media.js:711`).

### ۲.۴ PDF

- `isPdfAnalysisRequest` (`pdf.js:327`) بدون کپشن false برمی‌گرداند و `everyday.js:2026` هم `cap &&` را لازم دارد. پس PDF بدون کپشن به دکمه‌های «تصویر/فایل» می‌رسد که متن آن برای PDF نامناسب است. پیشنهاد: برای `application/pdf` دکمه‌های اختصاصی «خلاصه»، «استخراج متن» و «ذخیره».
- `parsePdfCreateCommand` (`pdf.js:332`) regex سخت‌گیرانه دارد. بهتر است intent `pdf_create` به NLU اضافه شود.
- `everyday.js:2658`: بعد از `sendDocument` نتیجه بررسی نمی‌شود و `pdfSent = true` ثابت است. همچنین «PDF آماده شد» حتی در صورت شکست ارسال می‌شود.
- `b64ToBytes`/`bytesToBase64` در `media.js` و `pdf.js` تکراری‌اند. باید یک ماژول `src/bytes.js` ساخته شود.

### ۲.۵ تلگرام HTML

- اصلاح C6 و C7: هر `**x**` در `everyday.js` با `<b>${escapeHtml(x)}</b>` جایگزین شود و `\\n` با `\n`.
- `tgApi`:
```js
const res = await fetch(url, { ..., signal: AbortSignal.timeout(8000) });
const json = await res.json().catch(() => ({ ok: false }));
if (!json.ok) console.warn(JSON.stringify({ tg: method, code: json.error_code ?? res.status }));
return json;
```
- پیام‌های خطای فنی مثل `vision_unavailable: gemini-...:429; nvidia-...` (`everyday.js:2072, 2619`) و `diagErrors` در کپشن (`:2604, :2631`) مستقیم به کاربر نشان داده می‌شوند. این‌ها باید فقط در لاگ بروند و کاربر یک پیام کوتاه فارسی بگیرد.
- پیام «در حال ویرایش…» (`:2572`) یک پیام جدا می‌فرستد. بهتر است از `sendProgressMessage` و ویرایش همان پیام استفاده شود، همان‌طور که در `answerChatText` انجام می‌شود.

---

## ۳. معماری: قابلیت‌های جدید و صرفه‌جویی در Free tier

### ۳.۱ صرفه‌جویی KV/D1/Subrequest
| مورد | فعلی | پیشنهاد |
|------|------|---------|
| round-robin (`router.js:478`) | نوشتن KV در هر درخواست | شمارنده در حافظه‌ی isolate یا `Date.now() % n`؛ صفر نوشتن. |
| health (`health.js`) | نوشتن KV با dedup درون isolate | انتقال به D1 (`router_provider_cb` در `circuit.js` از قبل هست). سقف نوشتن D1 در Free ۱۰۰ هزار در روز است، در مقابل ۱۰۰۰ برای KV. |
| draft و pending ask (`everyday.js:199`) | KV با TTL | جدول D1 `ephemeral(key, value, expires_at)` همراه purge در cron موجود. |
| dedup `update_id` (C8) | حافظه | `INSERT OR IGNORE INTO tg_updates(update_id)` و در صورت `changes = 0` خروج. |
| catalog (`catalog.js`) | `STATE.get` برای هر provider | یک کلید `catalog:all` یا cache در حافظه با TTL ۶۰ ثانیه. |
| `circuit.js ensureTables` | اجرای CREATE در هر isolate | انتقال به migration در `db.js` (یک‌بار). |

### ۳.۲ بلوپرینت ماژولار فاز ۴ تا ۶
- **فاز ۴: Skill registry.** فایل `src/skills/index.js` با قرارداد زیر:
  ```js
  export const skill = { id, intents: ["image_edit"], match(o) {...}, async run(env, o, ctx) {...}, budgetMs: 20000 };
  ```
  `handleDailyText` به یک dispatcher حدود ۵۰ خطی تبدیل می‌شود. پیشنهاد: `everyday.js` (۲۹۸۲ خط) به `skills/{image,pdf,vault,reminder,expense,note,task}.js` شکسته شود.
- **فاز ۵: Budget/Deadline context.** هر update یک `deadline = start + 25s` داشته باشد که در `ctx` به همه‌ی skillها برسد. هر fetch از `ctx.signal()` استفاده کند و قبل از اتمام بودجه، یک پیام fallback ارسال شود.
- **فاز ۶: Queue برای کارهای سنگین.** تولید و ویرایش تصویر و PDFهای بزرگ به Cloudflare Queues (در Free tier هست) یا یک تماس self-fetch با `waitUntil` جدا منتقل شوند تا سقف ۳۰ ثانیه دور زده شود.
- **قابلیت‌های پیشنهادی:** PDF Q&A با تکه‌بندی و ذخیره‌ی متن در D1، OCR→تسک («این فاکتور رو هزینه ثبت کن»)، و حافظه‌ی واقعیت‌ها با `superseded_by` همراه تأیید کاربر.

---

## ۴. اولویت‌بندی

### Quick Wins (هر کدام کمتر از ۳۰ خط، PR کوچک)
1. C2: timeout برای Gemini vision (`media.js:675`).
2. C1: حذف `STATE.put` برای round-robin (`router.js:478`).
3. C3: مسیر SSE در HF Space (`media.js:338`).
4. C6 و C7: `\\n` و `**` در `everyday.js:2002, 2088, 2090, 2527`.
5. C4: افزودن `signal` به `editImage`.
6. C9: استفاده از `bytesToBase64` در `analyzeVaultImage`.
7. C11: timeout و بررسی `ok` در `tgApi`.
8. پنهان کردن `diagErrors` و خطاهای فنی از کاربر.

### Structural Upgrades
1. Deadline context سراسری برای هر update (C10).
2. dedup در D1 و انتقال health/draft از KV به D1 (C8، صرفه‌جویی در KV).
3. پایپ‌لاین «regex = hint، مدل = تصمیم‌گیرنده» و جداسازی `classifyIntent`.
4. ریپلای به متن و document، به همراه ستون `reply_to_tg_msg_id` (حافظه‌ی وابستگی).
5. جایگزینی ویرایش HF با یک مدل واقعی img2img/instruct (مثلاً یک Space از نوع Kontext/InstructPix2Pix) و endpoint جدید `router.huggingface.co`.
6. شکستن `everyday.js` به skillها (فاز ۴)، سپس Queue (فاز ۶).

هر تغییر رفتاری باید تست offline در `scripts/test-combos.mjs` یا `scripts/test-dev.mjs` داشته باشد.
