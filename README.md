# my-agent

ایجنت شخصی من روی Cloudflare Worker. این قدم اول است: یک ربات اکوی تلگرام.

## معماری

```
Telegram → Cloudflare Worker (src/index.js) → بعداً: مدل‌روتر، GitHub Actions + OpenCode، بله، upload.am
```

- Worker فقط پیام‌های متنی را می‌گیرد و هدر مخفی `X-Telegram-Bot-Api-Secret-Token` را با `TG_SECRET` مقایسه می‌کند.
- کار اصلی داخل `ctx.waitUntil` انجام می‌شود تا تلگرام هرگز منتظر نماند و تایم‌اوت نگیرد.

## رازها (secrets)

| کلید | کاربرد |
|---|---|
| `TG_TOKEN` | توکن بات از BotFather |
| `TG_SECRET` | رشته تصادفی برای تأیید وبهوک |
| `ALLOWED_TG_IDS` | آی‌دی‌های عددی مجاز، جدا با کاما |

- این‌ها هرگز در گیت نمی‌روند.
- لوکال: فایل `.dev.vars` بساز (کپی از `.dev.vars.example`) — برای `scripts/set-webhook.mjs`.
- روی کلودفلر: `npx wrangler secret put TG_TOKEN` و همین‌طور `TG_SECRET` و `ALLOWED_TG_IDS`.

## دیپلوی

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## وبهوک

```bash
node scripts/set-webhook.mjs https://my-agent.<subdomain>.workers.dev/telegram
node scripts/set-webhook.mjs --info   # بررسی وضعیت وبهوک
```

## آی‌دی من را چطور پیدا کنم؟

به بات پیام `/id` بده؛ آی‌دی عددی خودت را جواب می‌دهد (این دستور برای همه باز است و فقط یک بار لازم است). آی‌دی را در `ALLOWED_TG_IDS` بگذار.

## نقشه راه

- [ ] مدل‌روتر (ترکیب چند مدل)
- [ ] GitHub Actions + OpenCode
- [ ] صدا و عکس با Workers AI
- [ ] بله (Bale)
- [ ] upload.am
- [ ] آزمایش WhatsApp
