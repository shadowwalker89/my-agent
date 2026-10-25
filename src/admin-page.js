// صفحه‌ی /admin — یک فایل HTML با CSS/JS داخل همان فایل (بدون فریمورک/بیلد).
// همه‌ی متن‌ها از دیکشنری I18N (en/fa) می‌آیند؛ هیچ متن خام در DOM.
// داده‌ی server فقط با textContent به DOM می‌رود (هرگز innerHTML).
// مقدار کلید provider هرگز از سرور نمی‌آید (فقط secretName) — نباید هم آمد.
export const ADMIN_HTML = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>my-agent admin</title>
<style>
:root{--bg:#f5f6fa;--card:#fff;--line:#e2e5ef;--txt:#181b23;--muted:#6a7185;--acc:#2456d6;--acc-soft:#e8eeff;--ok:#12833a;--ok-soft:#e2f5e8;--warn:#b25e09;--warn-soft:#fdeede;--bad:#c22525;--bad-soft:#fde8e8}
*{box-sizing:border-box}
body{font:14px/1.5 system-ui,'Segoe UI',Vazirmatn,Tahoma,sans-serif;margin:0;padding:18px;max-width:1080px;color:var(--txt);background:var(--bg)}
h1{font-size:19px;margin:0 auto 0 0}
h2{font-size:16px;margin:0 0 4px}
h3{font-size:14px;margin:8px 0 4px}
header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.tabs{display:flex;gap:4px;border-bottom:2px solid var(--line);margin:12px 0}
.tabs button{padding:8px 16px;border:none;background:none;font-size:14px;cursor:pointer;color:var(--muted);border-bottom:3px solid transparent;margin-bottom:-2px}
.tabs button.on{border-bottom-color:var(--acc);color:var(--acc);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 14px}
.subcard{background:#fafbfe;border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0}
.help{color:var(--muted);font-size:12px;margin:2px 0 10px}
table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{border:1px solid var(--line);padding:5px 8px;font-size:13px;text-align:start;vertical-align:top}
th{background:#f0f2f8}
button{margin:1px 2px;padding:4px 10px;font-size:12px;cursor:pointer;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--txt)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button.danger{background:#fff;border-color:var(--bad);color:var(--bad)}
button.ghost{background:none;border:none;color:var(--acc)}
button.lg{font-size:13px;padding:7px 14px}
button.sm{padding:2px 8px}
input,select{font-size:13px;padding:4px 6px;border:1px solid var(--line);border-radius:6px}
.line{display:flex;gap:8px;align-items:center;margin:4px 0;flex-wrap:wrap}
.hidden{display:none!important}
.hidecell{display:table-cell}
.mono{font-family:ui-monospace,Consolas,monospace;direction:ltr;text-align:start}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.b-ok{background:var(--ok-soft);color:var(--ok)}
.b-cool{background:var(--warn-soft);color:var(--warn)}
.b-ban{background:var(--bad-soft);color:var(--bad)}
.spin{display:inline-block;width:11px;height:11px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:-1px}
@keyframes spin{to{transform:rotate(360deg)}}
.err{color:var(--bad);white-space:pre-wrap;margin:6px 0}
.lbl{color:var(--muted);font-size:12px}
.progress{height:8px;background:var(--line);border-radius:999px;overflow:hidden}
.progress>div{height:100%;background:var(--acc);width:0;transition:width 0.2s}
.overlay{position:fixed;inset:0;background:rgba(12,14,22,0.45);display:flex;align-items:center;justify-content:center;z-index:50;padding:14px}
.pop{max-width:420px;width:100%;max-height:80vh;overflow:auto}
.toasts{position:fixed;bottom:14px;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:8px;z-index:60;pointer-events:none}
.toast{pointer-events:auto;cursor:pointer;background:#1d2230;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;max-width:92vw;box-shadow:0 4px 14px rgba(0,0,0,0.25)}
.toast.okly{background:#146c3c}
.toast.err{background:#8c1d1d}
.resx{font-size:22px;line-height:1}
.pre{white-space:pre-wrap;word-break:break-word;background:#f6f7fb;border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px}
.tscroll{overflow-x:auto}
.chkrow{display:flex;gap:6px;align-items:center;font-size:13px}
@media (max-width:640px){
  body{padding:10px}
  th,td{padding:3px 5px;font-size:12px}
  .hidecell{display:none}
  .tabs button{padding:6px 10px}
}
</style>
</head>
<body>
<header>
  <h1 data-i18n="title"></h1>
  <button id="langBtn" class="ghost" data-i18n="langBtn"></button>
  <button id="logoutBtn" class="ghost hidden" data-i18n="logout"></button>
</header>
<div id="toasts" class="toasts"></div>
<nav id="tabs" class="tabs hidden">
  <button type="button" id="tabBtnProv" data-tab="provTab" data-i18n="tabProviders"></button>
  <button type="button" id="tabBtnModels" data-tab="modelsTab" data-i18n="tabModels"></button>
  <button type="button" id="tabBtnCombos" data-tab="combosTab" data-i18n="tabCombos"></button>
</nav>

<div id="loginBox">
  <div class="card" style="max-width:420px">
    <h2 data-i18n="loginTitle"></h2>
    <form id="loginForm" class="line">
      <input type="password" id="loginKey" autocomplete="current-password" required style="flex:1">
      <button type="submit" id="loginGo" class="primary lg" data-i18n="login"></button>
    </form>
    <div id="loginErr" class="err"></div>
  </div>
</div>

<div id="appBox" class="hidden">
  <section id="provTab" class="tab">
    <div class="card">
      <div class="line"><h2 data-i18n="providers"></h2><button id="provAdd" class="primary lg" data-i18n="provAdd"></button></div>
      <p class="help" data-i18n="provHelp"></p>
      <div id="provForm" class="subcard hidden">
        <h3 id="provFormTitle"></h3>
        <div class="line">
          <span class="lbl" data-i18n="nameCol"></span><input id="pId" maxlength="40" class="mono">
          <span class="lbl" data-i18n="dispName"></span><input id="pName" maxlength="80">
        </div>
        <div class="line">
          <span class="lbl" data-i18n="baseUrl"></span><input id="pBase" class="mono" size="40" placeholder="https://...">
          <span class="lbl" data-i18n="secretName"></span><input id="pSecret" maxlength="60" class="mono">
          <label class="chkrow"><input type="checkbox" id="pEnabled" checked><span data-i18n="enabledCol"></span></label>
        </div>
        <div class="line">
          <button id="provSave" class="primary" data-i18n="save"></button>
          <button id="provCancel" data-i18n="cancel"></button>
        </div>
        <div id="provErr" class="err"></div>
      </div>
      <div class="tscroll">
        <table>
          <thead><tr>
            <th data-i18n="nameCol"></th><th data-i18n="dispName"></th><th class="hidecell" data-i18n="baseUrl"></th>
            <th data-i18n="secretName"></th><th data-i18n="secretPresent"></th><th data-i18n="enabledCol"></th>
            <th data-i18n="actions"></th>
          </tr></thead>
          <tbody id="provTbody"></tbody>
        </table>
      </div>
      <div id="provResult"></div>
    </div>
  </section>

  <section id="modelsTab" class="tab hidden">
    <div class="card">
      <div class="line"><h2 data-i18n="models"></h2></div>
      <p class="help" data-i18n="modelsHelp"></p>
      <div class="line">
        <span class="lbl" data-i18n="providerCol"></span><select id="mProvider"></select>
        <input id="mQ" class="mono" data-i18n-ph="qPh" size="24">
        <select id="mStatus">
          <option value="all" data-i18n="stAll"></option>
          <option value="ok" data-i18n="stOk"></option>
          <option value="cooldown" data-i18n="stCooldown"></option>
          <option value="banned" data-i18n="stBanned"></option>
        </select>
        <button id="mSearch" class="primary" data-i18n="search"></button>
        <button id="mTestAll" class="primary"></button>
        <button id="mStop" class="danger hidden" data-i18n="stopBtn"></button>
      </div>
      <div class="line">
        <label class="chkrow"><input type="checkbox" id="mOnlyOk"><span data-i18n="showOnlyOk"></span></label>
      </div>
      <div id="mProgress" class="hidden">
        <div class="progress"><div id="mBar"></div></div>
        <div id="mCount" class="lbl"></div>
      </div>
      <div id="mErr" class="err"></div>
      <div id="mResult"></div>
      <div class="tscroll">
        <table>
          <thead><tr><th data-i18n="modelCol"></th><th data-i18n="statusCol"></th><th data-i18n="actions"></th></tr></thead>
          <tbody id="mTbody"></tbody>
        </table>
      </div>
      <div id="mSummary"></div>
    </div>
  </section>

  <section id="combosTab" class="tab hidden">
    <div class="card">
      <div class="line"><h2 data-i18n="combos"></h2><button id="comboAdd" class="primary lg" data-i18n="comboAdd"></button></div>
      <p class="help" data-i18n="combosHelp"></p>
      <div id="comboForm" class="subcard hidden">
        <h3 id="comboFormTitle"></h3>
        <div class="line">
          <span class="lbl" data-i18n="comboName"></span><input id="cName" maxlength="40" class="mono">
          <span class="lbl" data-i18n="strategy"></span>
          <select id="cStrategy"><option>priority</option><option>round-robin</option><option>fastest</option></select>
          <span class="lbl" data-i18n="timeoutMs"></span><input id="cTimeout" type="number" min="1000" max="60000" value="20000" style="width:90px">
          <span class="lbl" data-i18n="retries"></span><input id="cRetries" type="number" min="0" max="3" value="0" style="width:60px">
        </div>
        <h3 data-i18n="targets"></h3>
        <div id="tgtBox"></div>
        <div class="line">
          <button id="tgtAdd" data-i18n="tgtAdd"></button>
          <button id="comboSave" class="primary" data-i18n="save"></button>
          <button id="comboCancel" data-i18n="cancel"></button>
        </div>
        <div id="comboErr" class="err"></div>
      </div>
      <div id="comboList"></div>
    </div>
  </section>
</div>
<div id="ovl"></div>

<script>
'use strict';
var I18N = {
  en: {
    title: 'my-agent admin',
    langBtn: 'FA / فارسی',
    loginTitle: 'Admin login',
    login: 'Log in',
    loginFail: 'login failed',
    logout: 'Log out',
    tabProviders: 'Providers',
    tabModels: 'Models',
    tabCombos: 'Combos',
    providers: 'Providers',
    models: 'Models',
    combos: 'Combos',
    provHelp: 'Providers are the OpenAI-compatible upstreams requests are routed to; built-ins cannot be deleted, only disabled.',
    modelsHelp: 'Search the cached catalog of each provider; badges show live status — ok, cooldown or banned. Test models individually or run "Test all".',
    combosHelp: 'Manual combos try their targets in the listed order (or rotate/fastest); disabled, banned or cooling-down targets are skipped.',
    provAdd: 'Add provider',
    comboAdd: 'Add combo',
    newProvider: 'New provider',
    newCombo: 'New combo',
    editProvider: 'Edit provider',
    del: 'Delete',
    refresh: 'Refresh catalog',
    testB: 'Test',
    save: 'Save',
    saved: 'Saved',
    delDone: 'Deleted',
    cancel: 'Cancel',
    nameCol: 'Id',
    dispName: 'Name',
    baseUrl: 'Base URL',
    secretName: 'Secret name',
    secretPresent: 'Secret present',
    enabledCol: 'Enabled',
    statusCol: 'Status',
    modelCol: 'Model',
    providerCol: 'Provider',
    actions: 'Actions',
    yes: 'yes',
    no: 'no',
    on: 'on',
    off: 'off',
    builtinNote: 'built-in',
    confirmDel: 'Delete',
    missingField: 'fill id, base URL and secret name',
    nameRequired: 'enter a name',
    stAll: 'all',
    stOk: 'ok',
    stCooldown: 'cooldown',
    stBanned: 'banned',
    search: 'Search',
    qPh: 'model id (contains)...',
    testAll: 'Test all',
    stopBtn: 'Stop',
    testing: 'Testing...',
    tooManyMsg: 'More than 60 models match this filter — only the first 60 will be tested. Narrow the filter by provider or search to test all of them.',
    runDone: 'Run finished',
    failedC: 'failed',
    fastest: 'Fastest working models',
    showOnlyOk: 'Show only working',
    addCombo: 'Add to combo',
    addToQ: 'Add to which combo?',
    newComboOpt: 'New combo...',
    newComboHint: 'New combo: enter a name and save.',
    addedDone: 'added',
    noModels: 'No models match this filter.',
    needSearch: 'Run a search first.',
    testCombo: 'Test combo',
    comboTested: 'combo',
    lblTimeout: 'Request timed out.',
    lblAuth: 'The API key was rejected by the provider (401/403).',
    lblNotFound: 'This model or account was not found (404).',
    lblRate: 'Rate limited (429) — try again later.',
    lblServer: 'Provider server error (5xx).',
    lblUnknown: 'Unknown error.',
    timeoutMs: 'Timeout (ms)',
    retries: 'Retries',
    comboName: 'Name',
    strategy: 'Strategy',
    targets: 'Targets',
    tgtAdd: 'Add target',
    tgtRemove: 'Remove',
    maxTargetsMsg: 'max 30 targets per combo',
    needTarget: 'at least one target required',
    maxLimitReached: 'Max 30 targets reached.'
  },
  fa: {
    title: 'پنل مدیریت my-agent',
    langBtn: 'EN / English',
    loginTitle: 'ورود مدیر',
    login: 'ورود',
    loginFail: 'ورود ناموفق بود',
    logout: 'خروج',
    tabProviders: 'Providerها',
    tabModels: 'مدل‌ها',
    tabCombos: 'Comboها',
    providers: 'Providerها',
    models: 'مدل‌ها',
    combos: 'Comboها',
    provHelp: 'Providerها همان سرویس‌های سازگار با OpenAI هستند که درخواست‌ها به آن‌ها می‌روند؛ داخلی‌ها حذف نمی‌شوند، فقط غیرفعال می‌شوند.',
    modelsHelp: 'کاتالوگ کش‌شده‌ی هر provider را جستجو کن؛ نشان‌ها وضعیت زنده‌اند — سالم، کول‌داون یا بن‌شده. مدل‌ها را تک‌به‌تک تست کن یا «تست همه» را بزن.',
    combosHelp: 'comboهای دستی هدف‌هایشان را به همان ترتیب (یا چرخشی/سریع‌ترین) امتحان می‌کنند؛ هدفِ خاموش، بن‌شده یا سردشده رد می‌شود.',
    provAdd: 'افزودن provider',
    comboAdd: 'افزودن combo',
    newProvider: 'provider تازه',
    newCombo: 'combo تازه',
    editProvider: 'ویرایش provider',
    del: 'حذف',
    refresh: 'به‌روزرسانی کاتالوگ',
    testB: 'تست',
    save: 'ذخیره',
    saved: 'ذخیره شد',
    delDone: 'حذف شد',
    cancel: 'انصراف',
    nameCol: 'شناسه',
    dispName: 'نام',
    baseUrl: 'آدرس پایه',
    secretName: 'نام راز',
    secretPresent: 'راز موجود؟',
    enabledCol: 'فعال',
    statusCol: 'وضعیت',
    modelCol: 'مدل',
    providerCol: 'Provider',
    actions: 'عملیات',
    yes: 'بله',
    no: 'خیر',
    on: 'روشن',
    off: 'خاموش',
    builtinNote: 'داخلی',
    confirmDel: 'حذف شود؟',
    missingField: 'شناسه، آدرس پایه و نام راز را پر کن',
    nameRequired: 'یک نام وارد کن',
    stAll: 'همه',
    stOk: 'سالم',
    stCooldown: 'کول‌داون',
    stBanned: 'بن‌شده',
    search: 'جستجو',
    qPh: 'شناسه‌ی مدل (شامل)...',
    testAll: 'تست همه',
    stopBtn: 'ایست',
    testing: 'در حال تست...',
    tooManyMsg: 'بیش از ۶۰ مدل با این فیلتر منطبق است — فقط ۶۰ مورد اول تست می‌شود. برای تست همه، فیلتر را با provider یا جستجو محدودتر کن.',
    runDone: 'اجرای تست تمام شد',
    failedC: 'شکست',
    fastest: 'سریع‌ترین مدل‌های سالم',
    showOnlyOk: 'فقط نشان دادن سالم‌ها',
    addCombo: 'افزودن به combo',
    addToQ: 'به کدام combo اضافه شود؟',
    newComboOpt: 'combo تازه...',
    newComboHint: 'combo تازه: یک نام بنویس و ذخیره کن.',
    addedDone: 'اضافه شد',
    noModels: 'مدلی با این فیلتر نیست.',
    needSearch: 'اول جستجو کن.',
    testCombo: 'تست combo',
    comboTested: 'combo',
    lblTimeout: 'زمان صبر تمام شد.',
    lblAuth: 'کلید API از طرف provider رد شد (401/403).',
    lblNotFound: 'این مدل یا حساب پیدا نشد (404).',
    lblRate: 'محدودیت نرخ (429) — بعداً امتحان کن.',
    lblServer: 'خطای سرور provider (5xx).',
    lblUnknown: 'خطای نامشخص.',
    timeoutMs: 'مهلت (ms)',
    retries: 'تلاش مجدد',
    comboName: 'نام',
    strategy: 'استراتژی',
    targets: 'هدف‌ها',
    tgtAdd: 'افزودن هدف',
    tgtRemove: 'برداشتن',
    maxTargetsMsg: 'حداکثر ۳۰ هدف در هر combo',
    needTarget: 'حداقل یک هدف لازم است',
    maxLimitReached: 'سقف ۳۰ هدف پر شد.'
  }
};
var STATUS_KEY = { ok: 'stOk', cooldown: 'stCooldown', banned: 'stBanned' };
var STATUS_CLASS = { ok: 'b-ok', cooldown: 'b-cool', banned: 'b-ban' };
var LABEL_KEYS = { timeout: 'lblTimeout', auth: 'lblAuth', notfound: 'lblNotFound', ratelimit: 'lblRate', server: 'lblServer', unknown: 'lblUnknown' };
var TARGET_LIMIT = 30;
var TEST_ALL_CONCURRENCY = 3;
var TEST_ALL_CAP = 60;

var lang = (localStorage.getItem('admin_lang') === 'fa') ? 'fa' : 'en';
var TABS = ['provTab', 'modelsTab', 'combosTab'];
var CFG = null;
var CUR_MODELS = [];
var CUR_PROVIDER = '';
var MODEL_RESULTS = {};
var ROW_ELS = {};
var runActive = false;
var runStopping = false;

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function btn(text, fn, cls) {
  var b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
function secs(ms) { return (ms === null || ms === undefined) ? '' : (ms / 1000).toFixed(1) + 's'; }

function T(key) { return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key; }

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'fa') ? 'rtl' : 'ltr';
  localStorage.setItem('admin_lang', lang);
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
  nodes = document.querySelectorAll('[data-i18n-ph]');
  for (var j = 0; j < nodes.length; j++) nodes[j].placeholder = T(nodes[j].getAttribute('data-i18n-ph'));
  $('langBtn').textContent = T('langBtn');
  if (CFG) {
    renderProviders();
    renderCombos();
    renderRows();
  }
}

$('langBtn').addEventListener('click', function () {
  lang = (lang === 'en') ? 'fa' : 'en';
  applyLang();
});

function toast(msg, kind) {
  var t = el('div', 'toast ' + (kind || ''), String(msg));
  $('toasts').appendChild(t);
  var hide = function () {
    t.remove();
  };
  t.addEventListener('click', hide);
  setTimeout(hide, 4200);
}

function busy(btnEl) {
  if (btnEl.dataset.busy) return;
  btnEl.dataset.busy = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '';
  btnEl.appendChild(el('span', 'spin'));
  btnEl.appendChild(document.createTextNode(' ' + T('testing')));
}
function idle(btnEl) {
  if (!btnEl.dataset.busy) return;
  btnEl.disabled = false;
  btnEl.textContent = btnEl.dataset.busy;
  delete btnEl.dataset.busy;
}

async function api(method, url, body) {
  var opt = { method: method };
  if (body !== undefined) {
    opt.headers = { 'content-type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  var res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    toast(String(e), 'err');
    return { status: 0, data: null, error: String(e) };
  }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) {
    showLogin();
    toast((data && data.error) ? data.error : T('loginFail'), 'err');
    return { status: 401, data: data, error: (data && data.error) || 'unauthorized' };
  }
  if (res.ok === false) {
    var msg = (data && data.error) ? data.error : ('http ' + res.status);
    toast(msg, 'err');
    return { status: res.status, data: data, error: msg };
  }
  return { status: res.status, data: data, error: '' };
}

function showErr(id, msg) { $(id).textContent = msg ? String(msg) : ''; }

function showLogin() {
  CFG = null;
  $('tabs').classList.add('hidden');
  $('appBox').classList.add('hidden');
  $('loginBox').classList.remove('hidden');
  $('logoutBtn').classList.add('hidden');
}
function showApp() {
  $('loginBox').classList.add('hidden');
  $('tabs').classList.remove('hidden');
  $('appBox').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  showTab(localStorage.getItem('admin_tab') || 'provTab');
}

var activeTab = null;
function showTab(id) {
  if (TABS.indexOf(id) < 0) id = 'provTab';
  activeTab = id;
  localStorage.setItem('admin_tab', id);
  var map = { provTab: 'tabBtnProv', modelsTab: 'tabBtnModels', combosTab: 'tabBtnCombos' };
  TABS.forEach(function (t) { $(t).classList.toggle('hidden', t !== id); });
  TABS.forEach(function (t) { $(map[t]).classList.toggle('on', t === id); });
}
TABS.forEach(function (t) {
  $(t === 'provTab' ? 'tabBtnProv' : t === 'modelsTab' ? 'tabBtnModels' : 'tabBtnCombos').addEventListener('click', function () { showTab(t); });
});

$('logoutBtn').addEventListener('click', async function () {
  await api('POST', '/admin/logout');
  showLogin();
});

$('loginForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var go = $('loginGo');
  var key = $('loginKey').value;
  $('loginKey').value = '';
  busy(go);
  var res;
  try {
    res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key })
    });
  } catch (e) {
    idle(go);
    $('loginErr').textContent = String(e);
    return;
  }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  idle(go);
  if (res.ok) {
    $('loginErr').textContent = '';
    await boot();
  } else {
    $('loginErr').textContent = (data && data.error) ? data.error : T('loginFail');
  }
});

async function boot() {
  var r = await api('GET', '/admin/api/config');
  if (r.data && r.data.ok) {
    CFG = r.data;
    showApp();
    renderAll();
  }
}

// ── نتیجه‌کارت ──────────────────────────────────────────────────────────────
function labelText(r) {
  var code = (r && r.label && LABEL_KEYS[r.label]) ? r.label : null;
  if (!code && r && r.ok === false) {
    if (String(r.snippet || '').indexOf('timeout') === 0) code = 'timeout';
    else if (r.status === 401 || r.status === 403) code = 'auth';
    else if (r.status === 404) code = 'notfound';
    else if (r.status === 429) code = 'ratelimit';
    else if (typeof r.status === 'number' && r.status >= 500) code = 'server';
    else code = 'unknown';
  }
  return code ? T(LABEL_KEYS[code]) : '';
}

function resultCard(r, name) {
  var c = el('div', 'subcard');
  var head = el('div', 'line');
  head.appendChild(el('span', 'resx', r.ok ? '\u2705' : '\u274c'));
  head.appendChild(el('strong', 'mono', name));
  if (r.latencyMs !== null && r.latencyMs !== undefined) {
    head.appendChild(el('span', 'lbl', secs(r.latencyMs)));
  }
  if (r.ok && r.used) head.appendChild(el('span', 'lbl', r.used));
  c.appendChild(head);
  if (r.ok === false) {
    var lt = labelText(r);
    if (lt) c.appendChild(el('div', 'lbl', lt));
  }
  var body = r.text || r.snippet || r.error || '';
  if (body) c.appendChild(el('div', 'pre mono', String(body).slice(0, 200)));
  return c;
}
function showResult(areaId, r, name) {
  var area = $(areaId);
  area.textContent = '';
  if (r) area.appendChild(resultCard(r, name));
}

// ── providerها ──────────────────────────────────────────────────────────────
function renderProviders() {
  var tb = $('provTbody');
  tb.textContent = '';
  CFG.providers.forEach(function (p) {
    var tr = el('tr');
    tr.appendChild(el('td', 'mono', p.id));
    tr.appendChild(el('td', null, p.name || ''));
    tr.appendChild(el('td', 'mono hidecell', p.baseUrl || ''));
    tr.appendChild(el('td', 'mono', p.secretName || ''));
    tr.appendChild(el('td', null, p.secretName ? '\u2705' : '\u274c'));
    tr.appendChild(el('td', null, (p.enabled === false) ? T('off') : T('on')));
    var act = el('td');
    var b1 = btn(T('testB'), function () { testProvider(p.id, b1); }, 'sm');
    act.appendChild(b1);
    act.appendChild(btn(T('refresh'), function () { refreshProvider(p.id); }, 'sm'));
    act.appendChild(btn(T('editProvider'), function () { openProviderForm(p.id); }, 'sm'));
    var del = btn(T('del'), function () { deleteProvider(p.id); }, 'sm danger');
    if (p.builtin) {
      del.disabled = true;
      del.title = T('builtinNote');
    }
    act.appendChild(del);
    tr.appendChild(act);
    tb.appendChild(tr);
  });
}

async function testProvider(id, btnEl) {
  busy(btnEl);
  var r = await api('POST', '/admin/api/test', { provider: id });
  idle(btnEl);
  if (r.data) showResult('provResult', r.data, id);
}

async function refreshProvider(id) {
  var r = await api('POST', '/admin/api/providers/' + encodeURIComponent(id) + '/refresh');
  if (r.data && r.data.ok) {
    toast('[' + id + '] +' + r.data.added + ' / -' + r.data.removed, 'okly');
  }
}

async function deleteProvider(id) {
  var p = null;
  CFG.providers.forEach(function (x) { if (x.id === id) p = x; });
  if (p && p.builtin) return;
  if (!window.confirm(T('confirmDel') + ' [' + id + ']?')) return;
  var r = await api('DELETE', '/admin/api/providers/' + encodeURIComponent(id));
  if (r.data && r.data.ok) {
    toast('[' + id + '] ' + T('delDone'), 'okly');
    await boot();
  }
}

function openProviderForm(id) {
  var p = null;
  CFG.providers.forEach(function (x) { if (x.id === id) p = x; });
  $('provFormTitle').textContent = p ? T('editProvider') : T('newProvider');
  $('pId').value = p ? p.id : '';
  $('pId').disabled = p ? Boolean(p.builtin) : false;
  $('pName').value = p ? (p.name || '') : '';
  $('pBase').value = p ? (p.baseUrl || 'https://') : 'https://';
  $('pSecret').value = p ? (p.secretName || '') : '';
  $('pEnabled').checked = p ? (p.enabled !== false) : true;
  showErr('provErr', '');
  $('provForm').classList.remove('hidden');
}

async function saveProvider() {
  var id = $('pId').value.trim();
  var body = {
    id: id,
    name: $('pName').value.trim() || id,
    baseUrl: $('pBase').value.trim(),
    secretName: $('pSecret').value.trim(),
    enabled: $('pEnabled').checked
  };
  if (!body.id || !body.baseUrl || !body.secretName) {
    showErr('provErr', T('missingField'));
    return;
  }
  var r = await api('PUT', '/admin/api/providers/' + encodeURIComponent(id), body);
  if (r.data && r.data.ok) {
    $('provForm').classList.add('hidden');
    toast('[' + id + '] ' + T('saved'), 'okly');
    await boot();
  } else {
    showErr('provErr', r.error || 'error');
  }
}

// ── مدل‌ها ──────────────────────────────────────────────────────────────────
function fillProviderSelects() {
  var sel = $('mProvider');
  var prev = sel.value;
  sel.textContent = '';
  CFG.providers.forEach(function (p) {
    var o = el('option', null, p.id + ((p.enabled === false) ? ' (' + T('off') + ')' : ''));
    o.value = p.id;
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
}

function badgeFor(m) {
  var r = MODEL_RESULTS[m.id];
  if (r && r.ok === true) return el('span', 'badge b-ok', '\u2705 ' + secs(r.latencyMs));
  if (r && r.ok === false) return el('span', 'badge b-ban', '\u274c ' + labelText(r));
  return el('span', 'badge ' + (STATUS_CLASS[m.status] || ''), T(STATUS_KEY[m.status] || 'stOk'));
}

function renderRows() {
  var tb = $('mTbody');
  tb.textContent = '';
  ROW_ELS = {};
  if (!CUR_PROVIDER) {
    $('mErr').textContent = T('needSearch');
    if (!runActive) $('mTestAll').textContent = T('testAll') + ' (0)';
    refreshBusy();
    return;
  }
  shownModels().forEach(function (m) {
    var tr = el('tr');
    tr.appendChild(el('td', 'mono', m.id));
    var bd = el('td');
    bd.appendChild(badgeFor(m));
    tr.appendChild(bd);
    var act = el('td');
    var bt = btn(T('testB'), function () { testModel(CUR_PROVIDER, m.id, bt); }, 'sm');
    var ab = btn(T('addCombo'), function () { openAddToCombo(CUR_PROVIDER, m.id); }, 'sm');
    act.appendChild(bt);
    act.appendChild(ab);
    tr.appendChild(act);
    tb.appendChild(tr);
    ROW_ELS[m.id] = { bed: bd, test: bt, add: ab };
  });
  var n = shownModels().length;
  $('mErr').textContent = n ? '' : T('noModels');
  var total = filteredCount();
  if (!runActive) $('mTestAll').textContent = T('testAll') + ' (' + (total ? Math.min(total, TEST_ALL_CAP) : 0) + ')';
  refreshBusy();
}

function shownModels() {
  var st = $('mStatus').value;
  var out = CUR_MODELS.filter(function (m) { return st === 'all' || m.status === st; });
  if ($('mOnlyOk').checked) out = out.filter(function (m) { return MODEL_RESULTS[m.id] && MODEL_RESULTS[m.id].ok === true; });
  return out;
}

function filteredCount() {
  var st = $('mStatus').value;
  return CUR_MODELS.filter(function (m) { return st === 'all' || m.status === st; }).length;
}

function refreshBusy() {
  $('mTestAll').disabled = runActive;
  $('mStop').classList.toggle('hidden', !runActive);
  $('mSearch').disabled = runActive;
  $('mStatus').disabled = runActive;
  $('mProvider').disabled = runActive;
  $('mQ').disabled = runActive;
  $('mOnlyOk').disabled = runActive;
  Object.keys(ROW_ELS).forEach(function (mid) {
    ROW_ELS[mid].test.disabled = runActive;
    ROW_ELS[mid].add.disabled = runActive;
  });
}

async function searchModels() {
  var id = $('mProvider').value;
  var q = $('mQ').value.trim();
  var r = await api('GET', '/admin/api/models?provider=' + encodeURIComponent(id) + (q ? '&q=' + encodeURIComponent(q) : ''));
  if (!(r.data && r.data.ok)) return;
  CUR_MODELS = r.data.models || [];
  CUR_PROVIDER = id;
  MODEL_RESULTS = {};
  renderRows();
}

async function testModel(prov, mid, btnEl) {
  busy(btnEl);
  var r = await api('POST', '/admin/api/test', { provider: prov, model: mid });
  idle(btnEl);
  if (r.data) {
    MODEL_RESULTS[mid] = r.data;
    showResult('mResult', r.data, prov + '/' + mid);
    repaintRow(mid);
  }
}

function repaintRow(mid) {
  var cell = ROW_ELS[mid] && ROW_ELS[mid].bed;
  if (!cell) return;
  var badge = badgeFor({ id: mid, status: 'ok' });
  cell.textContent = '';
  cell.appendChild(badge);
}

// ── تست همه (پیمایشی، هم‌زمانی ۳) ───────────────────────────────────────────
async function runTestAll() {
  if (runActive) return;
  var list = shownModels();
  if (!list.length) { toast(T('noModels'), 'err'); return; }
  if (list.length > TEST_ALL_CAP) {
    toast(T('tooManyMsg'), 'err');
    list = list.slice(0, TEST_ALL_CAP);
  }
  var prov = CUR_PROVIDER;
  var total = list.length;
  var done = 0, okc = 0, failc = 0;
  runActive = true;
  runStopping = false;
  refreshBusy();
  $('mProgress').classList.remove('hidden');
  $('mBar').style.width = '0%';
  $('mCount').textContent = '0/' + total + ' — ' + T('stOk') + ': 0 · ' + T('failedC') + ': 0';
  $('mStop').disabled = false;
  $('mTestAll').textContent = T('testing');
  $('mSummary').textContent = '';
  var idx = 0;
  var results = [];
  async function worker() {
    while (!runStopping) {
      var i = idx++;
      if (i >= total) break;
      var m = list[i];
      var r = await api('POST', '/admin/api/test', { provider: prov, model: m.id });
      var data = r.data || { ok: false, label: 'unknown', latencyMs: null };
      MODEL_RESULTS[m.id] = data;
      if (data.ok) okc++; else failc++;
      done++;
      results.push({ id: m.id, data: data });
      repaintRow(m.id);
      $('mBar').style.width = Math.round((done / total) * 100) + '%';
      $('mCount').textContent = done + '/' + total + ' — ' + T('stOk') + ': ' + okc + ' · ' + T('failedC') + ': ' + failc;
    }
  }
  var workers = [];
  for (var k = 0; k < TEST_ALL_CONCURRENCY; k++) workers.push(worker());
  await Promise.all(workers);
  runActive = false;
  runStopping = false;
  refreshBusy();
  $('mProgress').classList.add('hidden');
  renderRows();
  var sum = el('div', 'subcard');
  sum.appendChild(el('strong', null, T('runDone') + ' — ' + T('stOk') + ': ' + okc + ' · ' + T('failedC') + ': ' + failc));
  var good = results.filter(function (x) { return x.data.ok; });
  good.sort(function (a, b) { return (a.data.latencyMs || 0) - (b.data.latencyMs || 0); });
  good.slice(0, 5).forEach(function (x) {
    var line = el('div', 'line');
    line.appendChild(el('span', 'mono badge b-ok', '\u2705 ' + x.id + ' — ' + secs(x.data.latencyMs)));
    line.appendChild(btn(T('addCombo'), function () { openAddToCombo(prov, x.id); }, 'sm'));
    sum.appendChild(line);
  });
  $('mSummary').textContent = '';
  $('mSummary').appendChild(sum);
}

// ── افکتِ «افزودن به combo» ─────────────────────────────────────────────────
function closeOverlay() {
  var o = $('ovl');
  o.className = '';
  o.textContent = '';
}

function openAddToCombo(prov, model) {
  var ov = $('ovl');
  ov.className = 'overlay';
  ov.textContent = '';
  var card = el('div', 'card pop');
  card.appendChild(el('strong', 'mono', prov + '/' + model));
  card.appendChild(el('p', 'help', T('addToQ')));
  CFG.combos.forEach(function (c) {
    card.appendChild(btn(c.name + ' (' + ((c.targets || []).length) + ')', async function () {
      closeOverlay();
      await addToCombo(c, prov, model);
    }, 'sm'));
  });
  if (!CFG.combos.length) card.appendChild(el('p', 'lbl', T('newComboHint')));
  var line = el('div', 'line');
  line.appendChild(btn(T('newComboOpt'), function () { closeOverlay(); openNewComboPrefill(prov, model); }, 'primary'));
  line.appendChild(btn(T('cancel'), closeOverlay, 'ghost'));
  card.appendChild(line);
  ov.appendChild(card);
}

$('ovl').addEventListener('click', function (ev) {
  if (ev.target.id === 'ovl') closeOverlay();
});

async function addToCombo(c, prov, model) {
  var targets = (c.targets || []).map(function (t) {
    return { provider: t.provider, model: t.model, enabled: t.enabled !== false };
  });
  targets.push({ provider: prov, model: model, enabled: true });
  if (targets.length > TARGET_LIMIT) { toast(T('maxTargetsMsg'), 'err'); return; }
  var r = await api('PUT', '/admin/api/combos/' + encodeURIComponent(c.name), {
    name: c.name, strategy: c.strategy, timeoutMs: c.timeoutMs, retries: c.retries || 0, targets: targets
  });
  if (r.data && r.data.ok) {
    toast(prov + '/' + model + ' → [' + c.name + '] ' + T('addedDone'), 'okly');
    await boot();
  }
}

function openNewComboPrefill(prov, model) {
  showTab('combosTab');
  $('comboFormTitle').textContent = T('newCombo');
  $('cName').value = '';
  $('cStrategy').value = 'priority';
  $('cTimeout').value = '20000';
  $('cRetries').value = '0';
  var box = $('tgtBox');
  box.textContent = '';
  box.appendChild(tgtRow({ provider: prov, model: model }));
  showErr('comboErr', '');
  $('comboForm').classList.remove('hidden');
  $('cName').focus();
}

// ── comboها ────────────────────────────────────────────────────────────────
function tgtRow(t) {
  var row = el('div', 'line tgt-row');
  var sel = el('select');
  CFG.providers.forEach(function (p) {
    var o = el('option', null, p.id);
    o.value = p.id;
    sel.appendChild(o);
  });
  sel.value = t.provider || ((CFG.providers[0] && CFG.providers[0].id) || '');
  var model = el('input', 'mono');
  model.placeholder = 'model-id';
  model.value = t.model || '';
  var en = el('input');
  en.type = 'checkbox';
  en.checked = t.enabled !== false;
  row.appendChild(sel);
  row.appendChild(model);
  row.appendChild(el('span', 'lbl', T('enabledCol')));
  row.appendChild(en);
  row.appendChild(btn('\u2191', function () {
    if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
  }, 'sm'));
  row.appendChild(btn('\u2193', function () {
    if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
  }, 'sm'));
  row.appendChild(btn(T('tgtRemove'), function () { row.remove(); }, 'sm danger'));
  row._prov = sel; row._model = model; row._en = en;
  return row;
}

function gatherTargets(box) {
  var out = [];
  var rows = box.querySelectorAll('.tgt-row');
  for (var i = 0; i < rows.length; i++) {
    out.push({ provider: rows[i]._prov.value, model: rows[i]._model.value.trim(), enabled: rows[i]._en.checked });
  }
  return out;
}

function renderCombos() {
  var list = $('comboList');
  list.textContent = '';
  CFG.combos.forEach(function (c) {
    var card = el('div', 'subcard');
    var head = el('div', 'line');
    head.appendChild(el('strong', 'mono', c.name));
    head.appendChild(el('span', 'lbl', c.strategy + ' · ' + c.timeoutMs + 'ms · ' + (c.retries || 0) + 'r · ' + ((c.targets || []).length) + 't'));
    var tb = btn(T('testCombo'), function () { testCombo(c.name, res, tb); }, 'sm');
    head.appendChild(tb);
    var db = btn(T('del'), function () { deleteCombo(c.name); }, 'sm danger');
    head.appendChild(db);
    card.appendChild(head);

    var res = el('div');
    card.appendChild(res);

    var opts = el('div', 'line');
    var st = el('select');
    ['priority', 'round-robin', 'fastest'].forEach(function (s2) {
      var o2 = el('option', null, s2);
      o2.value = s2;
      st.appendChild(o2);
    });
    st.value = c.strategy;
    var to = el('input');
    to.type = 'number'; to.min = '1000'; to.max = '60000'; to.value = c.timeoutMs; to.style.width = '90px';
    var re = el('input');
    re.type = 'number'; re.min = '0'; re.max = '3'; re.value = c.retries || 0; re.style.width = '60px';
    opts.appendChild(el('span', 'lbl', T('strategy'))); opts.appendChild(st);
    opts.appendChild(el('span', 'lbl', T('timeoutMs'))); opts.appendChild(to);
    opts.appendChild(el('span', 'lbl', T('retries'))); opts.appendChild(re);
    card.appendChild(opts);

    var box = el('div');
    (c.targets || []).forEach(function (t) { box.appendChild(tgtRow(t)); });
    card.appendChild(box);
    card.appendChild(btn(T('tgtAdd'), function () {
      if (box.children.length >= TARGET_LIMIT) { toast(T('maxLimitReached'), 'err'); return; }
      box.appendChild(tgtRow({}));
    }, 'sm'));
    card.appendChild(btn(T('save'), async function () {
      var body = { name: c.name, strategy: st.value, timeoutMs: Number(to.value), retries: Number(re.value), targets: gatherTargets(box) };
      if (body.targets.length > TARGET_LIMIT) { toast(T('maxTargetsMsg'), 'err'); return; }
      if (body.targets.length < 1) { toast(T('needTarget'), 'err'); return; }
      var r = await api('PUT', '/admin/api/combos/' + encodeURIComponent(c.name), body);
      if (r.data && r.data.ok) {
        toast('[' + c.name + '] ' + T('saved'), 'okly');
        await boot();
      }
    }, 'primary'));
    list.appendChild(card);
  });
}

async function testCombo(name, resEl, btnEl) {
  busy(btnEl);
  var r = await api('POST', '/admin/api/test', { combo: name });
  idle(btnEl);
  if (r.data) showResultEl(resEl, r.data, T('comboTested') + ' [' + name + ']');
}

function showResultEl(resEl, r, name) {
  resEl.textContent = '';
  if (r) resEl.appendChild(resultCard(r, name));
}

async function deleteCombo(name) {
  if (!window.confirm(T('confirmDel') + ' [' + name + ']?')) return;
  var r = await api('DELETE', '/admin/api/combos/' + encodeURIComponent(name));
  if (r.data && r.data.ok) {
    toast('[' + name + '] ' + T('delDone'), 'okly');
    await boot();
  }
}

function openComboFormBlank() {
  $('comboFormTitle').textContent = T('newCombo');
  $('cName').value = '';
  $('cStrategy').value = 'priority';
  $('cTimeout').value = '20000';
  $('cRetries').value = '0';
  var box = $('tgtBox');
  box.textContent = '';
  box.appendChild(tgtRow({}));
  showErr('comboErr', '');
  $('comboForm').classList.remove('hidden');
}

async function saveComboForm() {
  var name = $('cName').value.trim();
  var body = {
    name: name,
    strategy: $('cStrategy').value,
    timeoutMs: Number($('cTimeout').value),
    retries: Number($('cRetries').value),
    targets: gatherTargets($('tgtBox'))
  };
  if (!name) { showErr('comboErr', T('nameRequired')); return; }
  if (body.targets.length > TARGET_LIMIT) { showErr('comboErr', T('maxTargetsMsg')); return; }
  if (body.targets.length < 1) { showErr('comboErr', T('needTarget')); return; }
  var r = await api('POST', '/admin/api/combos', body);
  if (r.data && r.data.ok) {
    $('comboForm').classList.add('hidden');
    toast('[' + name + '] ' + T('saved'), 'okly');
    await boot();
  } else {
    showErr('comboErr', r.error || 'error');
  }
}

function renderAll() {
  renderProviders();
  renderCombos();
  fillProviderSelects();
  CUR_MODELS = [];
  CUR_PROVIDER = '';
  MODEL_RESULTS = {};
  $('mResult').textContent = '';
  $('mSummary').textContent = '';
  renderRows();
}

$('provAdd').addEventListener('click', function () { openProviderForm(null); });
$('provSave').addEventListener('click', saveProvider);
$('provCancel').addEventListener('click', function () { $('provForm').classList.add('hidden'); });
$('comboAdd').addEventListener('click', openComboFormBlank);
$('comboSave').addEventListener('click', saveComboForm);
$('comboCancel').addEventListener('click', function () { $('comboForm').classList.add('hidden'); });
$('tgtAdd').addEventListener('click', function () {
  if ($('tgtBox').children.length >= TARGET_LIMIT) { showErr('comboErr', T('maxLimitReached')); return; }
  $('tgtBox').appendChild(tgtRow({}));
});
$('mSearch').addEventListener('click', searchModels);
$('mQ').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') searchModels(); });
$('mStatus').addEventListener('change', renderRows);
$('mOnlyOk').addEventListener('change', renderRows);
$('mTestAll').addEventListener('click', runTestAll);
$('mStop').addEventListener('click', function () { runStopping = true; $('mStop').disabled = true; });

applyLang();
boot();
</script>
</body>
</html>`;
