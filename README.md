# my-agent

ایجنت شخصی من روی Cloudflare Worker. قدم ۱: اکوی تلگرام ✅ — قدم ۲: مدل‌روتر با comboها.

## وضعیت فعلی

- Worker: `https://my-agent.nova-02aa82bffef8.workers.dev`
- روی **حساب دوم** Cloudflare اجرا می‌شود (حساب اول مشکل ۱۱۰۱ داشت — پایین بخوان).
- وبهوک از مسیر `POST /setup` داخل خود Worker ثبت شده است. قدم ۱ تمام است.
- قدم ۲ (مدل‌روتر) کدش تمام است؛ فقط باید جای `PLACEHOLDER-...` در `src/combos.js` آی‌دی مدل واقعی گذاشت (پایین بخوان).

## تاریخچه و مشکل ۱۱۰۱

روی حساب اول Cloudflare همه‌ی Workerها روی workers.dev — حتی یک Hello World ساده —
HTTP 500 با `error code: 1101` می‌دادند و `wrangler tail` هم هیچ لاگی نشان نمی‌داد.
کد سالم بود؛ مشکل در سمت حساب/edge کلادفلر بود (احتمالاً محدودیت حساب).

اگر دوباره پیش آمد:

1. یک Worker حداقلی (Hello World) بساز و deploy کن.
2. اگر آن هم ۱۱۰۱ داد، مشکل سمت حساب است نه کد.
3. راه‌حل: حساب دیگر Cloudflare — `npx wrangler logout` بعد `npx wrangler login` و
   `npx wrangler whoami` برای اطمینان از حساب درست، بعد `npx wrangler deploy`.
4. بعد با `npx wrangler secret put` دوباره رازها را اضافه کن و وبهوک را دوباره با `/setup` ثبت کن.

## ویندوز و شبکه‌ی فیلترشده

- در این شبکه `curl` را با `--ssl-no-revoke` اجرا کن (بررسی ابطال گواهی شکست می‌خورد).
- `api.telegram.org` از شبکه‌ی من مسدود است؛ پس ثبت وبهوک از داخل خود Worker انجام می‌شود:
  `.\scripts\setup-webhook.ps1` (یا `-Info` برای بررسی وضعیت).
- `scripts/set-webhook.mjs` فقط در شبکه‌هایی کار می‌کند که مستقیم به تلگرام دسترسی دارند.

## معماری

```
Telegram → Cloudflare Worker (src/index.js) → مدل‌روتر (nvidia/openrouter) → بعداً: GitHub Actions + OpenCode، بله، upload.am
```

## رازها

- `TG_TOKEN`، `TG_SECRET`، `ALLOWED_TG_IDS` — رازهای تلگرام (قدم ۱).
- `NVIDIA_API_KEY` — کلید `https://integrate.api.nvidia.com/v1`.
- `OPENROUTER_API_KEY` — کلید `https://openrouter.ai/api/v1`.
- `ROUTER_KEY` — کلید Bearer برای Endpoint سازگار با OpenAI داخل Worker.

هر کدام فقط اینجاها هستند:

- در Cloudflare: `npx wrangler secret put <NAME>` (خودم اجرا می‌کنم).
- لوکال: فایل `.dev.vars` (در `.gitignore`).

هرگز در گیت نمی‌روند و در چت‌ها یا پیام‌ها (همچنین به OpenCode) پیست نمی‌شوند.

## مدل‌روتر

فایل‌ها:

- `src/providers.js` — تعریف providerها (baseUrl، نام راز کلید، هدرهای اضافی).
- `src/combos.js` — comboها: `chat`، `code`، `vision`، `fast`. هر combo یک آرایه‌ی ترتیبی از
  `{ provider, model }` است؛ روتتر به همان ترتیب امتحان می‌کند (fallback).
- `src/router.js` — منطق اجرا: `runCombo(env, combo_or_provider_model, body, opts)`.

### پر کردن PLACEHOLDERها

تا وقتی آی‌دی واقعی نگذاشته باشم، هدف‌هایی که `model`شان با `PLACEHOLDER` شروع شود
روتر می‌پرد و خطای واضح می‌دهد. برای دیدن آی‌دی‌های واقعی:

```
GET /admin/models?provider=nvidia
GET /admin/models?provider=openrouter                # فقط مدل‌های :free
GET /admin/models?provider=openrouter&all=1&q=gpt    # همه + فیلتر زیررشته
```

- (اول هدر `X-Setup-Key: <TG_SECRET>` را بده.) خروجی فقط `{ id }` است (برای openrouter
  اضافه‌ی `context_length` و `vision`)، مرتب بر اساس id.
- آی‌دی‌ها را در `src/combos.js` جای `PLACEHOLDER-...` بگذار و deploy کن.

### Endpoint سازگار با OpenAI

- `POST /v1/chat/completions` با هدر `Authorization: Bearer <ROUTER_KEY>`
  (مقایسه‌ی constant-time؛ بدون کلید ۴۰۱، اگر `ROUTER_KEY` ست نشده ۵۰۰ با نام راز جاافتاده).
  `body.model` یا نام combo است (مثلاً `"chat"`) یا `provider/model` مستقیم (مثلاً `"nvidia/<id>"`).
  `stream: true` = پاس‌اس‌اس‌ئی مستقیم از provider؛ `stream: false` = JSON کامل.
  هدر پاسخ `X-Router-Used` می‌گوید کدام هدف جواب داده.
- `GET /v1/models` با همان احراز هویت؛ آی‌دی‌ها همان نام comboها هستند.
- در شکست کامل: ۵۰۲ با لیست `{ target, status|reason }` — هرگز کلید یا بدنه‌ای که ممکن است
  راز برگرداند، متن‌ها تا ۲۰۰ حرف بریده می‌شوند.

### رفتار fallback

رفتن به هدف بعدی روی: خطای شبکه/timeout (per-target پیش‌فرض ۲۰ ثانیه)، HTTP
408/429/5xx، 400/404 (مدل پشتیبانی نمی‌شود)، 401/403 (ثبت به‌عنوان خطای کانفیگ و ادامه)،
یا پیام assistant خالی. کل تلاش‌ها با روزشده‌ی کلی `deadlineMs` (پیش‌فرض ۲۵ ثانیه) محدود می‌شوند.

### ربات تلگرام

برای کاربرهای allowlist شده: متن ساده (بدون `/`) → `typing` → combo `chat` با دستور
سیستم «پاسخ به زبان کاربر، فارسی اگر فارسی نوشت» و `temperature: 0.7`، روزشده‌ی ۲۵ ثانیه.
پاسخ‌های بلند در پیام‌های حداکثر ۴۰۰۰ نویسه‌ای می‌آیند. اگر var `SHOW_MODEL` برابر `"1"` باشد
(در `wrangler.jsonc` ست شده) خط آخر پیام `— <used>` است.

چرا روزشده‌ی ۲۵ ثانیه؟ چون endpoint تلگرام بعد از `ctx.waitUntil` نباید منتظر بماند؛
`waitFor_url`/waitUntil حدود ۳۰ ثانیه سقف دارد و بعد پاسخ تلگرام از دست می‌رود؛ ۲۵ ثانیه حاشیه‌ی امن می‌گذارد.

دستورهای تلگرام: `/start`، `/ping`، `/id` (و `/id` برای همه باز است). دستور ناشناس =
متن راهنمای کوتاه فارسی با لیست همین دستورها.

### چرا AgentRouter و Kiro در روتر ابری نیستند؟

عمداً حذف شده‌اند: AgentRouter با WAF کلاینت‌های غیر Claude-Code و IPهای دیتاسنتر را بلاک
می‌کند، و Kiro به یک سرور gateway نیاز دارد؛ روی Worker بی‌فایده است.

## دامنه اختصاصی (بعداً)

اگر روزی دامنه‌ای خریدم، آن را به Worker وصل کن (custom domain / route در `wrangler.jsonc`)
تا وابسته به workers.dev نباشیم؛ بعد دوباره `/setup` را اجرا کن تا وبهوک به آدرس جدید برود.

## آی‌دی من را چطور پیدا کنم؟

به بات پیام `/id` بده؛ آی‌دی عددی خودت را جواب می‌دهد (این دستور برای همه باز است). آی‌دی را در `ALLOWED_TG_IDS` بگذار.

## نقشه راه

- [x] Telegram echo Worker با allowlist و /setup
- [~] مدل‌روتر / combo مدل‌ها داخل Worker — **قدم ۲ در جریان**: روتتر و endpoint سازگار با OpenAI آماده؛ comboها همچنان PLACEHOLDER دارند تا آی‌دی واقعی از /admin/models گذاشته شود
- [ ] GitHub Actions + OpenCode برای کارهای کدنویسی
- [ ] صدا و عکس با Workers AI
- [ ] بله (Bale)
- [ ] upload.am
- [ ] آزمایش WhatsApp
