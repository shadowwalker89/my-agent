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
- `GEMINI_API_KEY` — کلید Google برای رونویسی صدا با `gemini-3.5-transcribe`؛ فقط همین‌جا و در Cloudflare است، هرگز در گیت یا چت نمی‌آید.
- `ADMIN_KEY` — کلید مجزای صفحه‌ی مدیریت (`/admin`، `/admin/api/*`، هدر `X-Setup-Key`
  و ثبت وبهوک از `/setup`). اگر ست نشده باشد برای سازگاری همان `TG_SECRET` به‌عنوان
  fallback استفاده می‌شود؛ کلید کوکی `admin_session` هم همین است (HMAC با `ADMIN_KEY`
  یا fallback). `TG_SECRET` فقط مخصوص رازِ وبهوک تلگرام می‌ماند (بررسی هدر
  `X-Telegram-Bot-Api-Secret-Token` و پارامتر `secret_token` در ثبت وبهوک).

هر کدام فقط اینجاها هستند:

- در Cloudflare: `npx wrangler secret put <NAME>` (خودم اجرا می‌کنم).
- لوکال: فایل `.dev.vars` (در `.gitignore`).

هرگز در گیت نمی‌روند و در چت‌ها یا پیام‌ها (همچنین به OpenCode) پیست نمی‌شوند.

## مدل‌روتر

فایل‌ها:

- `src/config.js` — تنظیم دستی در KV (`config:v1`): providerهای دستی و comboهای دستی
  (seed خودکار سه داخلی در اولین خواندن)، اعتبارسنجی، سقف‌ها و CRUD.
- `src/providers.js` — تعریف داخلی‌ها (baseUrl، نام راز کلید، هدرهای اضافی)،
  `listProviderModels(env, ctx)` برای کشف مدل‌ها (داخلی‌ها با مپر اختصاصی،
  بقیه با مپر عمومی سازگار با OpenAI).
- `src/combos.js` — قانون هر combo (`chat`، `code`، `vision`، `fast`) + امتیازدهی
  (`pickModels`، `diversify`، ثابت `WEIGHTS`) و هیوریستیک‌های اندازه/نسخه/نسل قدیمی.
- `src/catalog.js` — سینک کاتالوگ در KV و اعلان مدل‌های جدید.
- `src/overrides.js` — KV ابزارهای pin/ban/prefer.
- `src/health.js` — سلامت هر هدف در KV کوچک با TTL.
- `src/router.js` — `runCombo` و حل کردن هدف‌های هر combo.
- `src/index.js` — همه‌ی endpointها، scheduled و دستورهای تلگرام.

### کاتالوگ پویا (قدم ۲ب)

- Xkiro sync reporting and robust free detection via `access_tier` and pricing.
- Multi-kind combos (`text`, `code`, `vision`, `reasoning`, `fast`, `custom`), model capability tags, and tested-OK auto-fill.

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

- `catalog:nvidia` / `catalog:openrouter` / `catalog:xkiro` (و `catalog:<id>` داخلی‌ها)
  — لیست مدل‌ها + `updatedAt`.
- `overrides:v1` — `{ pins: { combo: [...] }, bans: [...], prefer: { combo: [...] } }`.
- `health:<provider>/<model>` — کوoldown هدف (TTL خودکار: 24h برای 404/410/400،
  10 دقیقه برای 429/5xx/timeout/empty)؛ کلید موجود = ناسالم.
- `health:provider:<name>` — خطای 401/403 کل provider را ۱ ساعت می‌بندد.
- `config:v1` — تنظیم دستی (patch 3ا): `{ providers, combos }`؛ نام راز ذخیره می‌شود،
  **هرگز مقدار کلید**.
- `rr:<combo>` — نشانگر چرخش round-robin برای combo دستی.
- `lat:<provider>/<model>` — ۵ نمونه‌ی آخر تأخیر موفق برای استراتژی `fastest` (میانه).

### تنظیم با تلگرام (کاربرهای allowlist)

- `/models [combo]` — هدف‌های برتر combo با امتیاز (📌 = pin) + پانویس «کول‌داونِ فعلی»
  (تعداد هدف‌های سردِ هر provider از کلیدهای موجود `health:*`). هندلر در try/catch است؛
  اگر شکست بخورد پیام کوتاه فارسی با نام خطا می‌آید (بدون هدر یا راز).
- `/refresh [provider|all]` — سینک دستی؛ جواب کوتاه `+added -removed` برای هر provider
  (یکی‌یکی پردازش می‌شوند؛ اگر یکی شکست بخورد بقیه ادامه می‌یابند).
- `/test <provider/model>` — یک chat completion کوچک (`max_tokens: 20`، روزشده‌ی ۲۰ ثانیه)
  مستقیم به همان provider (بدون فیلتر سلامت) و جواب کوتاه فارسی: وضعیت HTTP،
  تأخیر بر حسب ms و اسنیپت ۲۰۰ نویسه‌ای رازپاک‌شده از جواب/خطا. روی timeout پیام
  فارسی `timeout بعد از Ns` می‌آید.
- `/pin <combo> <provider/model>` و `/unpin <combo> <provider/model>` — pin اول combo می‌آید.
- `/ban <provider/model>` و `/unban <provider/model>` — بن همیشگی از همه‌ی comboها.
- `/prefer <combo> <rx1,rx2,...>` و `/prefer <combo> reset` — جایگزینی لیست prefer آن combo.
- `/status` — تعداد مدل کش‌شده‌ی هر provider، آخرین زمان سینک، تعداد بن/pین و
  همان شمارنده‌ی «کول‌داونِ فعلی» هر provider (منع کل provider هم جدا نمایش داده می‌شود).
- `/combos` — لیست comboهای دستی (نام، استراتژی، تعداد هدف‌ها) + خودکارها.
- `/start`، `/ping`، `/id` مثل قبل؛ `/id` برای همه باز است. دستور ناشناس = راهنمای کوتاه فارسی.

### Telegram combo routing (patch 3f)

پیش‌فرض هر کاربر تلگرام از allowlist در کلید KV `tgprefs:<userId>` است:
`{ combo: string|null, auto: boolean, show: boolean }` — پیش‌فرض: `combo=null` (یعنی `chat`)،
`auto=روشن`، `show=خاموش`. فیلدهای ناشناس نادیده گرفته می‌شوند و اندازه سقف دارد.

دستورها:

- `/combo` — گزینه‌های واقعی: comboهای دستی از `config:v1` (نام، kind، تعداد هدف) +
  داخلی‌های `chat/code/vision/fast` با برچسب «auto» + انتخاب فعلی کاربر.
- `/combo <name>` — ست کردن combo پیش‌فرض؛ نام ناشناس رد می‌شود و فهرست معتبرها را می‌دهد.
  `/combo clear` → برگشت به `chat`.
- `/route on|off` — روشن/خاموش کردن مسیریابی خودکارِ تسک.
- `/showmodel on|off` — نمایش «`- <combo> / <provider>/<model>`» در انتهای پاسخ همان کاربر؛
  اگر `SHOW_MODEL=1` یا فایل ورکشن ست شده باشد، همیشه بر آن مقدم است (override جهانی).

قانون مسیریابی خودکار: هر پیام متنی با `classifyTask` (ماژول `src/task-route.js`، تابع خالص)
در `vision | code | chat` طبقه‌بندی می‌شود: عکس/فایل تصویری → `vision`؛ fence سه‌گانه از
بک‌تیک، خطوط stack trace، `def`/`function`/`class` با `{` یا `:`، پسوندهای فایل مثل
`.js` `.mjs` `.cjs` `.jsx` `.ts` `.tsx` `.py` `.go`، واژه‌هایی مثل bug/error/compile/regex/sql/function/refactor
و معادل‌های فارسی (کد، باگ، خطا، تابع، کامپایل، ...) → `code`؛ در غیر این صورت `chat`
(محافظه‌کارانه: هرجا شک است پاسخ `chat` است).

انتخاب combo برای هر پاسخ: اولین گزینه‌ی «شناخته‌شده با حداقل یک هدف سالم» از ترتیب
`[نتیجه‌ی classifyTask (فقط وقتی auto روشن)، combo پیش‌فرض کاربر، chat]`. اگر combo انتخاب‌شده
در همان فراخوانی شکست بخورد، فقط یک‌بار (بدون حلقه) به پیش‌فرض کاربر و اگر همان است به `chat` برمی‌گردد
و در لاگ Worker یادداشت می‌شود. در هر بار پاسخ فقط یک خط لاگ بدون متن پیام/راز چاپ می‌شود:
`{combo, used, routed: auto|manual}`.

توجه: هنوز پردازش عکس در بات نیست؛ `classifyTask` فقط flag اختیاری `hasImage` را می‌پذیرد
(برای آینده). در پنل `/admin` تب Comboها هم comboهای داخلی به‌صورت کارت فقط‌خواندنی با
نشان «auto» و دکمه‌ی «ساخت نسخه‌ی دستی» (targets از انتخاب زنده، cap ۸) نمایش داده می‌شوند.

### providerها و comboهای دستی (قدم ۳ا)

علاوه بر سه داخلی (nvidia/openrouter/xkiro که خودکار seed می‌شوند)، می‌توان Provider
سازگار با OpenAI و combo دستی تعریف کرد — همه در `config:v1` در KV:

- Provider دستی: `{ id, name, baseUrl (فقط https), secretName, enabled }` —
  `secretName` باید نام یکی از رازهای موجود wrangler باشد (فقط **موجود بودن** چک می‌شود؛
  مقدار کلید هرگز در KV ذخیره یا برگردانده نمی‌شود). حداکثر ۲۰ provider.
- Combo دستی: `{ name, strategy: priority|round-robin|fastest, timeoutMs, retries,
  targets: [{ provider, model, enabled }] }` — حداکثر ۲۰ combo و ۳۰ هدف در هر combo؛
  نام‌ها `^[a-z0-9._-]{1,40}$` و با نام comboهای خودکار (`chat`/`code`/...) یکی یعنی
  نسخه‌ی دستی برنده است. اگر نام combo درخواستی از URL برابر یک combo دستی باشد
  (`"model": "<نام combo دستی>"`) همان استراتژی اجرا می‌شود: `priority` = ترتیب
  تعریف‌شده، `round-robin` = چرخش از نشانگر KV، `fastest` = مرتب بر اساس میانه‌ی
  تأخیر موفق‌های اخیر (بدون داده = ترتیب priority). دستور `/models <combo>` و
  `/v1/models` هر دو از comboهای دستی پشتیبانی می‌کنند.

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
- مدل‌های چندوجهی (vision/vl/omni) در همه‌ی comboها به‌جز `vision` جریمه‌ی
  `vlOmniPenalty` می‌گیرند (≈−۱۲) — در combo vision معلق می‌شود.
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

### صفحه‌ی مدیریت (قدم ۳ب / `GET /admin`)

یک صفحه‌ی HTML تک‌فایلی (بدون فریمورک و بیلد؛ CSS/JS داخل همان فایل در
`src/admin-page.js`) که فقط با APIهای `/admin/api/*` کار می‌کند:

- **ورود:** `GET /admin` همیشه صفحه برمی‌گرداند؛ اگر احراز نشده باشی، صفحه‌ی لاگین
  با یک فیلد کلمه‌ی عبور نمایش می‌شود. `POST /admin/login {key}` با کلید
  `ADMIN_KEY` (یا اگر ست نشده همان `TG_SECRET` — fallback؛ مقایسه‌ی constant-time،
  خطای عمومی، هیچ‌وقت بازتاب key) کوکی `admin_session` امضاشده می‌سازد
  (`HttpOnly; Secure; SameSite=Strict; 7 روز` — HMAC با همان کلید). `POST /admin/logout` کوکی را پاک می‌کند. احراز جایگزین:
  هدر `X-Setup-Key`.
- **بخش‌ها:** صفحه سه تب دارد (Providerها / مدل‌ها / Comboها؛ تب فعال در
  `localStorage` است). جدول providerها (نام/baseUrl/secretName/موجود بودن راز/فعال +
  دکمه‌های افزودن/ویرایش/حذف — داخلی‌ها حذف نمی‌شوند — به‌روزرسانی کاتالوگ/تست)، پنل
  مدل‌ها (جستجوی provider + متن، فیلتر وضعیت ok|cooldown|banned، دکمه‌ی تست هر مدل،
  «افزودن به combo» از هر ردیف و «تست همه» با هم‌زمانی ۳، سقف ۶۰ در هر اجرا، نوار
  پیشرفت و دکمه‌ی ایست و خلاصه‌ی ۵ مدل سریع‌ترین در پایان) و comboهای دستی (هر combo
  یک کارت ویرایشی با هدف‌های ترتیبی و دکمه‌های بالا/پایین و «تست combo»؛ حداکثر ۳۰
  هدف). نتیجه‌ی هر تست یک کارت با ✅/❌، تأخیر بر حسب ثانیه، ۲۰۰ نویسه‌ی اول جواب مدل
  و توضیح فارسی/انگلیسیِ دلیل شکست (timeout/auth/404/429/5xx/نامشخص) است؛ اعلان‌های
  موفقیت/خطا به‌صورت toast می‌آیند و متن server فقط با textContent (مقابله‌شده)
  تزریق می‌شود.
- **زبان:** دکمه‌ی تغییر EN/FA — انگلیسی پیش‌فرض؛ فارسی با `dir="rtl"`؛ انتخاب در
  `localStorage` ذخیره می‌شود. همه‌ی متن‌ها از یک دیکشنری (`I18N.en`/`I18N.fa`) می‌آیند.
- **ظاهر و نتایج:** تم سیستم/روشن/تیره (ذخیره در `localStorage` و اعمال پیش از رندر) و نتایج تست مدل‌ها/فیلترها/خلاصه‌ی تست‌همه در مرورگر می‌مانند؛ «پاک کردن نتایج» برای همین provider یا همه در دسترس است.
- **امنیت:** هدرهای `Content-Security-Policy: default-src 'self'; script-src 'self'
  'unsafe-inline'; style-src 'self' 'unsafe-inline';` و `X-Frame-Options: DENY` و
  `Cache-Control: no-store` روی `/admin`؛ هیچ داده‌ی server با innerHTML تزریق
  نمی‌شود؛ مقدار کلید provider هرگز نمایش/ذخیره نمی‌شود (فقط secretName و موجود بودن).

### Endpointها برای خودم

- `POST /admin/refresh?provider=<name|all>` (هدر `X-Setup-Key: <TG_SECRET>`) —
  سینک ترتیبی و برگرداندن `{ provider: { added, removed } }`.
- `GET /admin/catalog?combo=<name>` — لیست حل‌شده‌ی هدف‌ها با امتیاز و وضعیت سلامت (بدون راز).
- `GET /admin/test?target=<provider/model>` (هدر `X-Setup-Key: <TG_SECRET>`) —
  همان `/test` تلگرام: `{ ok, provider, model, status, latencyMs, snippet }`
  (snippet رازپاک‌شده).
- `GET /admin/models?provider=<name>` — همان کاتالوگ زنده با فیلتر `q`/`all=1`
  (فقط `{ id }` و برای openrouter/xkiro `context_length`/`vision` در صورت وجود).

### Admin JSON API (قدم ۳ا)

همه‌ی مسیرهای `/admin/api/*` فقط JSON برمی‌گردانند (`{ ok, ... }` یا `{ ok:false, error }`).
احراز هویت: هدر `X-Setup-Key: <ADMIN_KEY>` (اگر ست نشده fallback: TG_SECRET) یا
کوکی امضاشده‌ی `admin_session=<exp>.<hmac>` (HMAC-SHA256 از exp با همان کلید؛
مقایسه‌ی constant-time).
مقدار کلید provider در هیچ جوابی نمی‌آید — فقط `secretName`:

- `GET /admin/api/config` — کل تنظیم (providers + combos، بدون راز).
- `POST /admin/api/providers` و `PUT/DELETE /admin/api/providers/<id>` — CRUD provider.
- `POST /admin/api/providers/<id>/refresh` — سینک همان provider.
- `POST /admin/api/combos` و `PUT/DELETE /admin/api/combos/<name>` — CRUD combo دستی.
- `GET /admin/api/models?provider=<id>&q=<rx>` — جستجوی کاتالوگ با وضعیت هر مدل:
  `ok` | `cooldown` (کلید health موجود) | `banned` (لیست بن‌ها).
- `POST /admin/api/test` با بدنه `{ provider, model }` — همان `/test` تلگرام
  (نتیجه‌ی کوتاه بدون راز).

### Endpoint سازگار با OpenAI

- `POST /v1/chat/completions` با هدر `Authorization: Bearer <ROUTER_KEY>`
  (مقایسه‌ی constant-time؛ بدون کلید ۴۰۱، اگر `ROUTER_KEY` ست نشده ۵۰۳ با پیام واضح).
  `body.model` یا `combo/<name>` است (مثلاً `"combo/chat"`) یا نام combo دستی (`"chat"`)
  یا `provider/model` مستقیم (مثلاً `"nvidia/<id>"`).
  `stream: true` = پاس‌اس‌اس‌ئی مستقیم از provider؛ `stream: false` = JSON کامل
  (شکل OpenAI نرمال: `object`, `created`, `usage`, `finish_reason` همیشه پر می‌شوند).
  هدر پاسخ `X-Router-Used` می‌گوید کدام هدف جواب داد.
- `GET /v1/models` با همان احراز هویت؛ comboها با آی‌دی `combo/<name>` و `owned_by: "router"` +
  مدل‌های sync‌شده‌ی providerها.
- در شکست کامل: ۵۰۲ با شکل خطای OpenAI + `available` (فهرست comboهای معتبر) —
  هرگز کلید یا بدنه‌ای که ممکن است راز برگرداند.
- کلاینت مرجع: `scripts/smoke-v1.mjs` (بدون نیاز به وابستگی).

### رفتار fallback و سلامت

رفتن به هدف بعدی روی: خطای شبکه/timeout (per-target پیش‌فرض ۲۰ ثانیه)، HTTP
408/429/5xx، 400/404 (مدل پشتیبانی نمی‌شود)، 401/403 (ثبت به‌عنوان خطای کانفیگ و ادامه)،
یا پیام assistant خالی. ست هر شکست در `health:*` ثبت می‌شود تا دفعه‌ی بعد آن هدف
(یا کل provider روی 401/403) خودکار رد شود. طبقه‌بندی شکست در یک تابع واحد
`classifyFailure` در `src/router.js` است:

- 404 با بدنه‌ی «Function … Not found for account» یا «404 page not found» → مدل، ۲۴ ساعت.
- 401/403 → کل provider یک ساعت؛ در همان درخواست بقیه‌ی مدل‌های همان provider هم رد
  می‌شوند و فقط یک پیام `provider X: key rejected (401)` می‌آید.
- timeout → مدل، ۱۰ دقیقه؛ برچسب «timeout» (هرگز «http undefined» چاپ نمی‌شود؛
  در `/test` پیام فارسی `timeout بعد از Ns` می‌آید).
- 429/503/5xx → مدل، ۱۵ دقیقه. 400/410 مثل قبل مدل، ۲۴ ساعت.

کل تلاش‌ها با روزشده‌ی کلی `deadlineMs` (پیش‌فرض ۲۵ ثانیه) محدود می‌شوند.

### ربات تلگرام

برای کاربرهای allowlist شده: متن ساده (بدون `/`) → `typing` → combo `chat` با دستور
سیستم «پاسخ به زبان کاربر، فارسی اگر فارسی نوشت» و `temperature: 0.7`، روزشده‌ی ۲۵ ثانیه.
پاسخ‌های بلند در پیام‌های حداکثر ۴۰۰۰ نویسه‌ای می‌آیند. اگر var `SHOW_MODEL` برابر `"1"` باشد
(در `wrangler.jsonc` ست شده) خط آخر پیام `— <used>` است.

چرا روزشده‌ی ۲۵ ثانیه؟ چون endpoint تلگرام بعد از `ctx.waitUntil` نباید منتظر بماند؛
`waitFor_url`/waitUntil حدود ۳۰ ثانیه سقف دارد و بعد پاسخ تلگرام از دست می‌رود؛ ۲۵ ثانیه حاشیه‌ی امن می‌گذارد.

دستورهای تلگرام: همه در بخش «تنظیم با تلگرام»؛ `/id` برای همه باز است. دستور ناشناس =
متن راهنمای کوتاه فارسی با لیست همین دستورها.

#### حریم خصوصی مسیریاب مدلی روزمره

قانون قدم ۱ این بود که متن روزمره به مدل خارجی نمی‌رود. این قانون، فقط برای
پیام‌های نامطمئن برگشته است: وقتی طبقه‌بند قانونی، پیام را با اطمینان حل
نکند (رده‌ی «مشکوک» یا «چت»)، فقط متن همان یک پیام — حداکثر ۳۰۰ نویسه —
برای طبقه‌بندی به مدل خارجی (ترکیب `chat`) فرستاده می‌شود. پیام‌های با
اطمینان قانونی، هرگز به مدل نمی‌رسند. برای پیام دنباله‌دار، فقط متن پرسش
قبلی خود بات هم همراه پیام جاری فرستاده می‌شود؛ این متن بات است، نه داده‌ی
کاربر. هرگز فرستاده نمی‌شود: تاریخچه‌ی چت، ردیف‌های پایگاه داده، شناسه یا
بایت فایل، و رازها. این طرح، فقط برای بات تک‌کاربره است؛ چندکاربره شدن،
نیاز به بازبینی دوباره‌ی این بخش دارد.

#### حریم خصوصی صدا (فاز ۱)

پیام صوتی برای رونویسی به Google فرستاده می‌شود (`gemini-3.5-transcribe`،
با راهنمای زبان `fa-IR` و واژگان سفارشی ثابت)؛ فقط متن رونوشت ذخیره
می‌شود و بایت صدا نگه داشته نمی‌شود — نه در پایگاه داده، نه در R2.
فایل بارگذاری‌شده در Google هم پس از رونویسی، با بهترین تلاش حذف
می‌شود. این طرح هم فقط برای بات تک‌کاربره است.

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
- [x] قدم ۳ا: providerها و comboهای دستی در KV + admin JSON API (رازها فقط با نام)
- [ ] GitHub Actions + OpenCode برای کارهای کدنویسی
- [ ] صدا و عکس با Workers AI
- [ ] بله (Bale)
- [ ] upload.am
- [ ] آزمایش WhatsApp

<!-- test dev pipeline -->
