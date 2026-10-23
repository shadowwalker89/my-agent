# my-agent

ایجنت شخصی من روی Cloudflare Worker. قدم اول: ربات اکوی تلگرام.

## وضعیت فعلی

- Worker: `https://my-agent.nova-02aa82bffef8.workers.dev`
- روی **حساب دوم** Cloudflare اجرا می‌شود (حساب اول مشکل ۱۱۰۱ داشت — پایین بخوان).
- وبهوک از مسیر `POST /setup` داخل خود Worker ثبت شده و تست اکوی تلگرام پاس شده است. قدم ۱ تمام است.

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
Telegram → Cloudflare Worker (src/index.js) → بعداً: مدل‌روتر، GitHub Actions + OpenCode، بله، upload.am
```

## رازها

`TG_TOKEN`، `TG_SECRET`، `ALLOWED_TG_IDS` فقط اینجاها هستند:

- در Cloudflare: `npx wrangler secret put TG_TOKEN` (و همین‌طور دو مورد دیگر).
- لوکال: فایل `.dev.vars` (در `.gitignore`).

هرگز در گیت نمی‌روند و در چت‌ها یا پیام‌ها (همچنین به OpenCode) پیست نمی‌شوند.

## دامنه اختصاصی (بعداً)

اگر روزی دامنه‌ای خریدم، آن را به Worker وصل کن (custom domain / route در `wrangler.jsonc`)
تا وابسته به workers.dev نباشیم؛ بعد دوباره `/setup` را اجرا کن تا وبهوک به آدرس جدید برود.

## آی‌دی من را چطور پیدا کنم؟

به بات پیام `/id` بده؛ آی‌دی عددی خودت را جواب می‌دهد (این دستور برای همه باز است). آی‌دی را در `ALLOWED_TG_IDS` بگذار.

## نقشه راه

- [x] Telegram echo Worker با allowlist و /setup
- [ ] مدل‌روتر / combo مدل‌ها داخل Worker
- [ ] GitHub Actions + OpenCode برای کارهای کدنویسی
- [ ] صدا و عکس با Workers AI
- [ ] بله (Bale)
- [ ] upload.am
- [ ] آزمایش WhatsApp
