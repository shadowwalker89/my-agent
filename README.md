# my-agent

ایجنت شخصی من روی Cloudflare Worker. قدم ۱: اکوی تلگرام ✅ — قدم ۲: مدل‌روتر با comboها.

## وضعیت فعلی

- Worker: `https://my-agent.nova-02aa82bffef8.workers.dev`
- روی **حساب دوم** Cloudflare اجرا می‌شود (حساب اول مشکل ۱۱۰۱ داشت — پایین بخوان).
- وبهوک از مسیر `POST /setup` داخل خود Worker ثبت شده است. قدم ۱ تمام است.
- قدم ۲ (مدل‌روتر) تمام است. قدم ۲ب: کاتالوگ پویا + comboهای قانون‌محور + کنترل از تلگرام —
  آی‌دی‌های combo دیگر دستی نیستند؛ از کاتالوگ کش‌شده در KV ساخته می‌شوند (پایین بخوان).

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
Telegram → Cloudflare Worker (src/index.js) → مدل‌روتر (nvidia/openrouter/xkiro) → بعداً: GitHub Actions + OpenCode، بله، upload.am
```

## رازها

- `TG_TOKEN`، `TG_SECRET`، `ALLOWED_TG_IDS` — رازهای تلگرام (قدم ۱).
- `NVIDIA_API_KEY` — کلید `https://integrate.api.nvidia.com/v1`.
- `OPENROUTER_API_KEY` — کلید `https://openrouter.ai/api/v1`.
- `XKIRO_API_KEY` — کلید `https://api.xkiro.com/v1`. طبق سایتش، آی‌دی مدل‌های رایگانش به
  `:free` ختم می‌شود و بعد از تأیید تلگرام سقف مصرف روزانه‌ی رایگان حدود ۱ میلیون توکن است.
  هشدار مهم: هر gateway رایگان شخص ثالث فقط برای مدل‌های عمومی است — هرگز راز یا
  کد خصوصی کلاینت به آن نفرست.
- `ROUTER_KEY` — کلید Bearer برای Endpoint سازگار با OpenAI داخل Worker.

هر کدام فقط اینجاها هستند:

- در Cloudflare: `npx wrangler secret put <NAME>` (خودم اجرا می‌کنم).
- لوکال: فایل `.dev.vars` (در `.gitignore`).

هرگز در گیت نمی‌روند و در چت‌ها یا پیام‌ها (همچنین به OpenCode) پیست نمی‌شوند.

## مدل‌روتر

فایل‌ها:

- `src/providers.js` — تعریف providerها (baseUrl، نام راز کلید، هدرهای اضافی) و
  `listFreeModels(env, provider)` برای کشف مدل‌های رایگان هر کدام.
- `src/combos.js` — قانون هر combo (`chat`، `code`، `vision`، `fast`) + امتیازدهی
  (`pickModels`، `diversify`، ثابت `WEIGHTS`) و هیوریستیک‌های اندازه/نسخه/نسل قدیمی.
- `src/catalog.js` — سینک کاتالوگ در KV و اعلان مدل‌های جدید.
- `src/overrides.js` — KV ابزارهای pin/ban/prefer.
- `src/health.js` — سلامت هر هدف در KV کوچک با TTL.
- `src/router.js` — `runCombo` و حل کردن هدف‌های هر combo.
- `src/index.js` — همه‌ی endpointها، scheduled و دستورهای تلگرام.

### کاتالوگ پویا (قدم ۲ب)

لیست مدل‌های رایگان مدام عوض می‌شود؛ پس دیگر آی‌دی‌ای در `src/combos.js` نیست.
ساختار کار:

1. **کشف:** هر provider از `GET /models` خودش لیست مدل‌های رایگان را می‌گیرد
   (`listFreeModels`); خروجی فقط `{ id, provider, context, vision, created }`.
   - openrouter/xkiro: فقط آی‌دی‌های `:free`.
   - nvidia: همه‌ی آی‌دی‌ها (رایگان‌اند) ولی مدل‌های غیرچت (embed/reward/asr/...) با regex حذف می‌شوند.
2. **سینک:** `syncProvider(env, provider)` نتیجه را در کلید KV `catalog:<provider>`
   می‌نویسد و با لیست قبلی مقایسه می‌کند؛ لیست «اضافه‌شده‌ها» را در یک پیام تلگرام
   (حداکثر ۱۵ آی‌دی، با پیشوند provider و سرنخ «/models برای مرور») به همه‌ی
   `ALLOWED_TG_IDS` می‌فرستد. اولین سینک اعلان نمی‌دهد.
3. **کرون:** سه cron در `wrangler.jsonc`: هر ۶ ساعت — دقیقه‌ی 0 = openrouter،
   دقیقه‌ی 10 = nvidia، دقیقه‌ی 20 = xkiro (هر اجرای scheduled فقط یک provider؛
   سقف subrequest/CPU پلن رایگان).
4. **انتخاب combo:** `getComboTargets` از کاتالوگِ flat + overrideها + سلامت،
   لیست ترتیبی هدف‌ها را می‌سازد: pinها اول، بعد کاندیدهای امتیازدهی‌شده با
   `diversify`: هرگز سه هدف پشت‌سرهم از یک provider نمی‌آید و وقتی بیش از یک
   provider کاندید دارد، سه هدف اول حداقل یکی از هر provider را دارد. بریده به
   `maxTargets`. اگر کاتالوگ خالی باشد خطای واضح می‌دهد: اول `/refresh` را بزن.

### KV

binding `STATE` بدون id (wrangler موقع deploy خودش می‌سازد؛ اگر نساخت، دستی بساز).
کلیدها:

- `catalog:nvidia` / `catalog:openrouter` / `catalog:xkiro` — لیست مدل‌ها + `updatedAt`.
- `overrides:v1` — `{ pins: { combo: [...] }, bans: [...], prefer: { combo: [...] } }`.
- `health:<provider>/<model>` — کوoldown هدف (TTL خودکار: 24h برای 404/410/400،
  10 دقیقه برای 429/5xx/timeout/empty)؛ کلید موجود = ناسالم.
- `health:provider:<name>` — خطای 401/403 کل provider را ۱ ساعت می‌بندد.

### تنظیم با تلگرام (کاربرهای allowlist)

- `/models [combo]` — هدف‌های برتر combo با امتیاز (📌 = pin).
- `/refresh [provider|all]` — سینک دستی؛ جواب کوتاه `+added -removed` برای هر provider
  (یکی‌یکی پردازش می‌شوند؛ اگر یکی شکست بخورد بقیه ادامه می‌یابند).
- `/test <provider/model>` — یک chat completion کوچک (`max_tokens: 20`، روزشده‌ی ۲۰ ثانیه)
  مستقیم به همان provider (بدون فیلتر سلامت) و جواب کوتاه فارسی: وضعیت HTTP،
  تأخیر بر حسب ms و اسنیپت ۲۰۰ نویسه‌ای رازپاک‌شده از جواب/خطا.
- `/pin <combo> <provider/model>` و `/unpin <combo> <provider/model>` — pin اول combo می‌آید.
- `/ban <provider/model>` و `/unban <provider/model>` — بن همیشگی از همه‌ی comboها.
- `/prefer <combo> <rx1,rx2,...>` و `/prefer <combo> reset` — جایگزینی لیست prefer آن combo.
- `/status` — تعداد مدل کش‌شده‌ی هر provider، آخرین زمان سینک، تعداد بن/pin.
- `/start`، `/ping`، `/id` مثل قبل؛ `/id` برای همه باز است. دستور ناشناس = راهنمای کوتاه فارسی.

### امتیازدهی (heuristic!)

کیفیت مدل را کسی به‌صورت خودکار نمی‌داند؛ رتبه‌بندی صرفاً **هیوریستیک** است:

- امتیاز پایه = مجموع وزن الگوهای prefer (اول‌تر = بیشتر) + بونوس کانتکست بزرگ‌تر +
  بونوس `created` تازه‌تر − جریمه‌ی preview/beta (وقتی prefer نخورده).
- **جریمه‌ی اندازه:** بزرگ‌ترین توکن `<عدد>b` در نام مدل (مؤلفه‌ی MoE مثل `a12b` نمی‌شمارد؛
  بزرگ‌ترین عدد مبناست): ≤14B جریمه‌ی سنگین، 15B–40B جریمه‌ی ملایم، ≥100B بونوس.
- **جریمه‌ی نسل قدیمی:** llama-3.0/3.1، mixtral، gemma-2/3، mistral-7b/nemo،
  minitron، nemotron-4/51b/70b، palmyra، codestral و مشابه‌ها جریمه می‌گیرند.
- الگوی `coder` فقط وقتی اعمال می‌شود که جریمه‌ی اندازه نخورده باشد —(coderهای خیلی
  کوچک به combo کدنویسی کمک نمی‌کنند).
- **بونوس نسخه:** درون یک provider + خانواده (کلید خانواده = بخش نام مدل تا اولین رقم،
  مثل `qwen3.8-max` → `qwen`)، نسخه‌ی بالاتر بونوس کوچک می‌گیرد تا نسل جدیدترِ همان
  خانواده اول بیاید. این هم صرفاً هیوریستیک است.
- **خطای upstream در کشف مدل:** شکست `GET /models` جواب امن برمی‌گرداند:
  `{ ok:false, provider, status, snippet }` — snippet اولین ۳۰۰ نویسه‌ی بدنه با
  پاک‌سازی هر چیزی شبیه راز (مقدار کلید provider و توکن‌های `sk-…`/`nvapi-…`).
  درخواست‌های کشف مدل هدر User-Agent مرورگرمانند دارند (`Mozilla/5.0 (compatible; my-agent/1.0)`)
  و هدرها هرگز لاگ/بازگردانده نمی‌شوند.
- **رد شدن در سطح provider:** 401/403 از یک provider در یک فراخوانی `runCombo` یعنی
  بقیه‌ی مدل‌های همان provider در همان درخواست رد می‌شوند و فقط یک پیام
  `provider X: key rejected (401)` برمی‌گردد؛ provider هم در KV یک ساعت منع می‌شود.

همه‌ی عددها در ثابت `WEIGHTS` بالای `src/combos.js` است — برای تنظیم فقط همان‌جا را
تغییر بده. قانون `prefer/exclude/minContext/needsVision/maxTargets` هر combo هم
همان فایل است.

تست آفلاین (بدون شبکه/KV/راز): `npm run test:offline`. فایل‌های فیکسچرِ آی‌دی عمومی
`xk-models.json`، `nv-models.json`، `or-models.json` را از ریشه می‌خواند (gitignored،
هرگز کامیت نمی‌شوند؛ فایل نبود یا object خطا بود رد می‌شود با پیام)، top-8 هر combo را
با امتیاز چاپ می‌کند و چند assert ساده (تنوع، نبود مدل embed/guard/… و حاضر بودن
مدل‌های اصلی در code) دارد؛ شکست = exit code 1.

### Endpointها برای خودم

- `POST /admin/refresh?provider=<name|all>` (هدر `X-Setup-Key: <TG_SECRET>`) —
  سینک ترتیبی و برگرداندن `{ provider: { added, removed } }`.
- `GET /admin/catalog?combo=<name>` — لیست حل‌شده‌ی هدف‌ها با امتیاز و وضعیت سلامت (بدون راز).
- `GET /admin/test?target=<provider/model>` (هدر `X-Setup-Key: <TG_SECRET>`) —
  همان `/test` تلگرام: `{ ok, provider, model, status, latencyMs, snippet }`
  (snippet رازپاک‌شده).
- `GET /admin/models?provider=<name>` — همان کاتالوگ زنده با فیلتر `q`/`all=1`
  (فقط `{ id }` و برای openrouter/xkiro `context_length`/`vision` در صورت وجود).

### Endpoint سازگار با OpenAI

- `POST /v1/chat/completions` با هدر `Authorization: Bearer <ROUTER_KEY>`
  (مقایسه‌ی constant-time؛ بدون کلید ۴۰۱، اگر `ROUTER_KEY` ست نشده ۵۰۰ با نام راز جاافتاده).
  `body.model` یا نام combo است (مثلاً `"chat"`) یا `provider/model` مستقیم (مثلاً `"nvidia/<id>"`).
  `stream: true` = پاس‌اس‌اس‌ئی مستقیم از provider؛ `stream: false` = JSON کامل.
  هدر پاسخ `X-Router-Used` می‌گوید کدام هدف جواب داده (قید فووتر پیام تلگرام با
  `SHOW_MODEL=1` هم همین کار را می‌کند).
- `GET /v1/models` با همان احراز هویت؛ آی‌دی‌ها همان نام comboها هستند.
- در شکست کامل: ۵۰۲ با لیست `{ target, status|reason }` — هرگز کلید یا بدنه‌ای که ممکن است
  راز برگرداند، متن‌ها تا ۲۰۰ حرف بریده می‌شوند.

### رفتار fallback و سلامت

رفتن به هدف بعدی روی: خطای شبکه/timeout (per-target پیش‌فرض ۲۰ ثانیه)، HTTP
408/429/5xx، 400/404 (مدل پشتیبانی نمی‌شود)، 401/403 (ثبت به‌عنوان خطای کانفیگ و ادامه)،
یا پیام assistant خالی. ست هر شکست در `health:*` ثبت می‌شود تا دفعه‌ی بعد آن هدف
(یا کل provider روی 401/403) خودکار رد شود. 401/403 در همان درخواست یعنی بقیه‌ی
مدل‌های همان provider هم رد می‌شوند و فقط یک پیام `provider X: key rejected (401)`
در لیست خطاها می‌آید. کل تلاش‌ها با روزشده‌ی کلی `deadlineMs`
(پیش‌فرض ۲۵ ثانیه) محدود می‌شوند.

### ربات تلگرام

برای کاربرهای allowlist شده: متن ساده (بدون `/`) → `typing` → combo `chat` با دستور
سیستم «پاسخ به زبان کاربر، فارسی اگر فارسی نوشت» و `temperature: 0.7`، روزشده‌ی ۲۵ ثانیه.
پاسخ‌های بلند در پیام‌های حداکثر ۴۰۰۰ نویسه‌ای می‌آیند. اگر var `SHOW_MODEL` برابر `"1"` باشد
(در `wrangler.jsonc` ست شده) خط آخر پیام `— <used>` است.

چرا روزشده‌ی ۲۵ ثانیه؟ چون endpoint تلگرام بعد از `ctx.waitUntil` نباید منتظر بماند؛
`waitFor_url`/waitUntil حدود ۳۰ ثانیه سقف دارد و بعد پاسخ تلگرام از دست می‌رود؛ ۲۵ ثانیه حاشیه‌ی امن می‌گذارد.

دستورهای تلگرام: همه در بخش «تنظیم با تلگرام»؛ `/id` برای همه باز است. دستور ناشناس =
متن راهنمای کوتاه فارسی با لیست همین دستورها.

### محدودیت‌های پلن رایگان (ریسک معلوم)

سیاق پلن رایگان: حدود ۱۰ms CPU در هر فراخوانی و ۵۰ زیردرخواست. به همین دلیل هر اجرای
`scheduled` فقط یک provider را سینک می‌کند (سه cron جدا در فاصله‌ی ۱۰ دقیقه) و صرفه‌جویی
subrequest در حل زدن روتتر هم انجام شده (حداکثر ۲۰ چک سلامت، pinها جدا حساب می‌شوند).
ریسک معلوم: پارس لیست خیلی بزرگ کاتالوگ (مثلاً JSON چندصدهزاربایتی openrouter) CPU می‌کشد؛
اگر اجرای cron خطای CPU quota خورد، کار را با `/refresh <provider>` (یا
`POST /admin/refresh?provider=<name>`) دستی و یکی‌یکی per provider تقسیم کن — هر فراخوانی
فقط یک provider را کامل می‌کند.

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
- [x] مدل‌روتر / combo مدل‌ها داخل Worker (قدم ۲: روتتر + endpoint سازگار با OpenAI، قدم ۲ب: کاتالوگ پویا، combo قانون‌محور، کنترل تلگرام — رتبه‌بندی کیفیت هیوریستیک است)
- [ ] GitHub Actions + OpenCode برای کارهای کدنویسی
- [ ] صدا و عکس با Workers AI
- [ ] بله (Bale)
- [ ] upload.am
- [ ] آزمایش WhatsApp
