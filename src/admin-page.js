// صفحه‌ی /admin — یک فایل HTML با CSS/JS داخل همان فایل (بدون فریمورک/بیلد).
// همه‌ی متن‌ها از دیکشنری I18N (en/fa) می‌آیند؛ هیچ متن خام در DOM.
// مقدار کلید provider هرگز از سرور نمی‌آید (فقط secretName) — نباید هم آمد.
export const ADMIN_HTML = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>my-agent admin</title>
<style>
body{font-family:system-ui,'Segoe UI',Vazirmatn,Tahoma,sans-serif;margin:16px;max-width:1100px;color:#111;background:#fff}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{border:1px solid #ccc;padding:4px 8px;font-size:13px;text-align:start;vertical-align:top}
th{background:#f3f3f3}
button{margin:1px 2px;padding:3px 8px;font-size:12px;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}
input,select{font-size:13px;padding:3px}
.hidden{display:none}
.err{color:#b00;white-space:pre-wrap;margin:6px 0}
.info{color:#067;white-space:pre-wrap;margin:6px 0}
.row{display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap}
.card{border:1px solid #ddd;border-radius:6px;padding:10px;margin:10px 0}
label{font-size:12px}
.mono{font-family:ui-monospace,Consolas,monospace;direction:ltr;text-align:start}
.st-ok{color:#080}.st-cool{color:#b60}.st-ban{color:#b00}
.lang{float:right}
</style>
</head>
<body>
<h1 data-i18n="title"></h1>
<button id="langBtn" type="button" class="lang"></button>
<button id="logoutBtn" type="button" class="lang hidden"></button>
<div id="errBar" class="err"></div>
<div id="infoBar" class="info"></div>

<div id="loginBox">
  <h2 data-i18n="loginTitle"></h2>
  <form id="loginForm" class="row">
    <input type="password" id="loginKey" autocomplete="current-password" required>
    <button type="submit" data-i18n="login"></button>
  </form>
  <div id="loginErr" class="err"></div>
</div>

<div id="appBox" class="hidden">
  <div class="card" id="provCard">
    <h2 data-i18n="providers"></h2>
    <button id="provAdd" type="button"></button>
    <div id="provForm" class="hidden">
      <h3 id="provFormTitle"></h3>
      <div class="row">
        <label data-i18n="name"></label><input id="pId" maxlength="40" class="mono">
        <label data-i18n="dispName"></label><input id="pName" maxlength="80">
      </div>
      <div class="row">
        <label data-i18n="baseUrl"></label><input id="pBase" class="mono" size="44" placeholder="https://...">
        <label data-i18n="secretName"></label><input id="pSecret" maxlength="60" class="mono">
        <label data-i18n="enabledCol"></label><input type="checkbox" id="pEnabled" checked>
      </div>
      <div class="row">
        <button id="provSave" type="button" data-i18n="save"></button>
        <button id="provCancel" type="button" data-i18n="cancel"></button>
      </div>
      <div id="provErr" class="err"></div>
    </div>
    <table>
      <thead><tr>
        <th data-i18n="name"></th><th data-i18n="dispName"></th><th data-i18n="baseUrl"></th>
        <th data-i18n="secretName"></th><th data-i18n="secretPresent"></th><th data-i18n="enabledCol"></th>
        <th data-i18n="actions"></th>
      </tr></thead>
      <tbody id="provTbody"></tbody>
    </table>
  </div>

  <div class="card" id="comboCard">
    <h2 data-i18n="combos"></h2>
    <button id="comboAdd" type="button"></button>
    <div id="comboForm" class="hidden">
      <h3 id="comboFormTitle"></h3>
      <div class="row">
        <label data-i18n="comboName"></label><input id="cName" maxlength="40" class="mono">
        <label data-i18n="strategy"></label>
        <select id="cStrategy"><option>priority</option><option>round-robin</option><option>fastest</option></select>
        <label data-i18n="timeoutMs"></label><input id="cTimeout" type="number" min="1000" max="60000" value="20000">
        <label data-i18n="retries"></label><input id="cRetries" type="number" min="0" max="3" value="0">
      </div>
      <h3 data-i18n="targets"></h3>
      <div id="tgtBox"></div>
      <div class="row">
        <button id="tgtAdd" type="button"></button>
        <button id="comboSave" type="button" data-i18n="save"></button>
        <button id="comboCancel" type="button" data-i18n="cancel"></button>
      </div>
      <div id="comboErr" class="err"></div>
    </div>
    <div id="comboList"></div>
  </div>

  <div class="card" id="modelCard">
    <h2 data-i18n="models"></h2>
    <div class="row">
      <label data-i18n="providerCol"></label>
      <select id="mProvider"></select>
      <input id="mQ" class="mono" data-i18n-ph="qPh" size="30">
      <button id="mSearch" type="button"></button>
    </div>
    <div id="mErr" class="err"></div>
    <div id="mResult" class="info"></div>
    <table>
      <thead><tr><th data-i18n="model"></th><th data-i18n="statusCol"></th><th data-i18n="actions"></th></tr></thead>
      <tbody id="mTbody"></tbody>
    </table>
  </div>
</div>

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
    providers: 'Providers',
    provAdd: 'Add provider',
    newProvider: 'New provider',
    editProvider: 'Edit provider',
    edit: 'Edit',
    del: 'Delete',
    refresh: 'Refresh catalog',
    testB: 'Test',
    save: 'Save',
    cancel: 'Cancel',
    name: 'Id',
    dispName: 'Name',
    baseUrl: 'Base URL',
    secretName: 'Secret name',
    secretPresent: 'Secret present',
    enabledCol: 'Enabled',
    statusCol: 'Status',
    actions: 'Actions',
    yes: 'yes',
    no: 'no',
    on: 'on',
    off: 'off',
    builtinNote: 'built-in',
    confirmDel: 'Delete',
    combos: 'Manual combos',
    comboAdd: 'Add combo',
    newCombo: 'New combo',
    editCombo: 'Edit combo',
    comboName: 'Name',
    strategy: 'Strategy',
    timeoutMs: 'Timeout (ms)',
    retries: 'Retries',
    targets: 'Targets',
    target: 'Target',
    model: 'Model',
    providerCol: 'Provider',
    up: 'Up',
    down: 'Down',
    tgtAdd: 'Add target',
    tgtRemove: 'Remove',
    maxTargetsMsg: 'max 30 targets per combo',
    needTarget: 'at least one target required',
    models: 'Models',
    search: 'Search',
    qPh: 'Search models...',
    stOk: 'ok',
    stCooldown: 'cooldown',
    stBanned: 'banned',
    noModels: 'no models cached for this provider yet — refresh the catalog first',
    testRes: 'Test result',
    refreshDone: 'catalog synced',
    saved: 'saved',
    testing: 'testing...',
    selectModel: 'enter a model id first'
  },
  fa: {
    title: 'پنل مدیریت my-agent',
    langBtn: 'EN / English',
    loginTitle: 'ورود مدیر',
    login: 'ورود',
    loginFail: 'ورود ناموفق بود',
    logout: 'خروج',
    providers: 'Providerها',
    provAdd: 'افزودن provider',
    newProvider: 'provider تازه',
    editProvider: 'ویرایش provider',
    edit: 'ویرایش',
    del: 'حذف',
    refresh: 'به‌روزرسانی کاتالوگ',
    testB: 'تست',
    save: 'ذخیره',
    cancel: 'انصراف',
    name: 'شناسه',
    dispName: 'نام',
    baseUrl: 'آدرس پایه',
    secretName: 'نام راز',
    secretPresent: 'راز موجود؟',
    enabledCol: 'فعال',
    statusCol: 'وضعیت',
    actions: 'عملیات',
    yes: 'بله',
    no: 'خیر',
    on: 'روشن',
    off: 'خاموش',
    builtinNote: 'داخلی',
    confirmDel: 'حذف شود؟',
    combos: 'comboهای دستی',
    comboAdd: 'افزودن combo',
    newCombo: 'combo تازه',
    editCombo: 'ویرایش combo',
    comboName: 'نام',
    strategy: 'استراتژی',
    timeoutMs: 'روزشده (ms)',
    retries: 'تلاش مجدد',
    targets: 'هدف‌ها',
    target: 'هدف',
    model: 'مدل',
    providerCol: 'provider',
    up: 'بالا',
    down: 'پایین',
    tgtAdd: 'افزودن هدف',
    tgtRemove: 'برداشتن',
    maxTargetsMsg: 'حداکثر ۳۰ هدف در هر combo',
    needTarget: 'حداقل یک هدف لازم است',
    models: 'مدل‌ها',
    search: 'جستجو',
    qPh: 'جستجوی مدل...',
    stOk: 'سالم',
    stCooldown: 'کول‌داون',
    stBanned: 'بن‌شده',
    noModels: 'هنوز مدلی برای این provider کش نشده — اول کاتالوگ را به‌روزرسانی کن',
    testRes: 'نتیجه تست',
    refreshDone: 'کاتالوگ سینک شد',
    saved: 'ذخیره شد',
    testing: 'در حال تست...',
    selectModel: 'اول شناسه مدل را وارد کن'
  }
};
var STATUS_KEY = { ok: 'stOk', cooldown: 'stCooldown', banned: 'stBanned' };
var STATUS_CLASS = { ok: 'st-ok', cooldown: 'st-cool', banned: 'st-ban' };
var TARGET_LIMIT = 30;

var lang = (localStorage.getItem('admin_lang') === 'fa') ? 'fa' : 'en';
var CFG = null;

function $(id) { return document.getElementById(id); }
function T(key) { return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key; }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function btn(labelKeyOrText, fn) {
  var b = el('button', null, labelKeyOrText);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
function showErr(msg) { $('errBar').textContent = msg ? String(msg) : ''; }
function showInfo(msg) { $('infoBar').textContent = msg ? String(msg) : ''; }

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'fa') ? 'rtl' : 'ltr';
  localStorage.setItem('admin_lang', lang);
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
  nodes = document.querySelectorAll('[data-i18n-ph]');
  for (var j = 0; j < nodes.length; j++) nodes[j].placeholder = T(nodes[j].getAttribute('data-i18n-ph'));
  $('langBtn').textContent = T('langBtn');
}
$('langBtn').addEventListener('click', function () {
  lang = (lang === 'en') ? 'fa' : 'en';
  applyLang();
});

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
    return { status: 0, data: null, error: String(e) };
  }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) { showLogin(); return { status: 401, data: data, error: (data && data.error) || 'unauthorized' }; }
  if (res.ok === false) {
    var msg = (data && data.error) ? data.error : ('http ' + res.status);
    showErr(msg);
    return { status: res.status, data: data, error: msg };
  }
  showErr('');
  return { status: res.status, data: data, error: '' };
}

function showLogin() {
  CFG = null;
  $('appBox').classList.add('hidden');
  $('loginBox').classList.remove('hidden');
  $('logoutBtn').classList.add('hidden');
}
function showApp() {
  $('loginBox').classList.add('hidden');
  $('appBox').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
}

$('logoutBtn').addEventListener('click', async function () {
  await api('POST', '/admin/logout');
  showLogin();
});

$('loginForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var key = $('loginKey').value;
  $('loginKey').value = '';
  var res;
  try {
    res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key })
    });
  } catch (e) {
    $('loginErr').textContent = String(e);
    return;
  }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
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

// ── providerها ──────────────────────────────────────────────────────────────
function renderProviders() {
  var tb = $('provTbody');
  tb.textContent = '';
  CFG.providers.forEach(function (p) {
    var tr = el('tr');
    tr.appendChild(el('td', 'mono', p.id));
    tr.appendChild(el('td', null, p.name || ''));
    tr.appendChild(el('td', 'mono', p.baseUrl || ''));
    tr.appendChild(el('td', 'mono', p.secretName || ''));
    tr.appendChild(el('td', null, p.secretName ? T('yes') : T('no')));
    tr.appendChild(el('td', null, (p.enabled === false) ? T('off') : T('on')));
    var act = el('td');
    act.appendChild(btn(T('testB'), function () { testProvider(p.id); }));
    act.appendChild(btn(T('refresh'), function () { refreshProvider(p.id); }));
    act.appendChild(btn(T('edit'), function () { openProviderForm(p.id); }));
    var del = btn(T('del'), function () { deleteProvider(p.id); });
    if (p.builtin) {
      del.disabled = true;
      del.title = T('builtinNote');
    }
    act.appendChild(del);
    tr.appendChild(act);
    tb.appendChild(tr);
  });
}

async function testProvider(id) {
  showInfo(T('testing'));
  var r = await api('POST', '/admin/api/test', { provider: id });
  if (r.data && r.data.ok) {
    showInfo(T('testRes') + ' [' + id + '] ' + JSON.stringify(r.data));
  } else {
    showErr((r.data && r.data.error) ? (id + ': ' + r.data.error) : 'test failed');
  }
}

async function refreshProvider(id) {
  var r = await api('POST', '/admin/api/providers/' + encodeURIComponent(id) + '/refresh');
  if (r.data && r.data.ok) {
    showInfo(T('refreshDone') + ' [' + id + '] +' + r.data.added + ' -' + r.data.removed);
  }
}

function deleteProvider(id) {
  var p = CFG.providers.find(function (x) { return x.id === id; });
  if (p && p.builtin) return;
  if (!window.confirm(T('confirmDel') + ' [' + id + ']?')) return;
  api('DELETE', '/admin/api/providers/' + encodeURIComponent(id)).then(async function () {
    await boot();
  });
}

function openProviderForm(id) {
  var p = null;
  for (var i = 0; i < CFG.providers.length; i++) if (CFG.providers[i].id === id) p = CFG.providers[i];
  $('provFormTitle').textContent = p ? T('editProvider') : T('newProvider');
  $('pId').value = p ? p.id : '';
  $('pId').disabled = p ? p.builtin : false;
  $('pName').value = p ? (p.name || '') : '';
  $('pBase').value = p ? (p.baseUrl || 'https://') : 'https://';
  $('pSecret').value = p ? (p.secretName || '') : '';
  $('pEnabled').checked = p ? (p.enabled !== false) : true;
  $('provErr').textContent = '';
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
    $('provErr').textContent = 'missing field(s)';
    return;
  }
  var r = await api('PUT', '/admin/api/providers/' + encodeURIComponent(id), body);
  if (r.data && r.data.ok) {
    $('provForm').classList.add('hidden');
    showInfo(T('saved') + ': [' + id + ']');
    await boot();
  } else {
    $('provErr').textContent = (r.data && r.data.error) ? r.data.error : (r.error || 'error');
  }
}

// ── comboها ────────────────────────────────────────────────────────────────
function renderCombos() {
  var box = $('comboList');
  box.textContent = '';
  CFG.combos.forEach(function (c) {
    var row = el('div', 'row');
    row.appendChild(el('strong', 'mono', c.name));
    row.appendChild(el('span', null, c.strategy + ' | ' + T('timeoutMs') + ': ' + c.timeoutMs + ' | ' + T('retries') + ': ' + c.retries));
    row.appendChild(el('span', 'mono', c.targets.map(function (t) { return t.provider + '/' + t.model + (t.enabled === false ? ' (off)' : ''); }).join(', ')));
    row.appendChild(btn(T('edit'), function () { openComboForm(c.name); }));
    row.appendChild(btn(T('del'), function () { deleteCombo(c.name); }));
    box.appendChild(row);
  });
}

function tgtRow(t) {
  var row = el('div', 'row tgt-row');
  var sel = el('select');
  CFG.providers.forEach(function (p) {
    var o = el('option', null, p.id);
    o.value = p.id;
    sel.appendChild(o);
  });
  sel.value = t.provider || (CFG.providers[0] ? CFG.providers[0].id : '');
  var model = el('input', 'mono');
  model.placeholder = 'model-id';
  model.value = t.model || '';
  var en = el('input');
  en.type = 'checkbox';
  en.checked = t.enabled !== false;
  row.appendChild(sel);
  row.appendChild(model);
  row.appendChild(el('span', null, T('enabledCol')));
  row.appendChild(en);
  row.appendChild(btn(T('up'), function () {
    if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
  }));
  row.appendChild(btn(T('down'), function () {
    if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
  }));
  row.appendChild(btn(T('tgtRemove'), function () { row.remove(); }));
  row._prov = sel; row._model = model; row._en = en;
  return row;
}

function openComboForm(name) {
  var c = null;
  for (var i = 0; i < CFG.combos.length; i++) if (CFG.combos[i].name === name) c = CFG.combos[i];
  $('comboFormTitle').textContent = c ? T('editCombo') : T('newCombo');
  $('cName').value = c ? c.name : '';
  $('cStrategy').value = c ? c.strategy : 'priority';
  $('cTimeout').value = c ? c.timeoutMs : 20000;
  $('cRetries').value = c ? c.retries : 0;
  var box = $('tgtBox');
  box.textContent = '';
  (c ? c.targets : []).forEach(function (t) { box.appendChild(tgtRow(t)); });
  $('comboErr').textContent = '';
  $('comboForm').classList.remove('hidden');
}

async function saveCombo() {
  var rows = document.querySelectorAll('#tgtBox .tgt-row');
  var targets = [];
  for (var i = 0; i < rows.length; i++) {
    var tat = rows[i];
    targets.push({
      provider: tat._prov.value,
      model: tat._model.value.trim(),
      enabled: tat._en.checked
    });
  }
  if (targets.length > TARGET_LIMIT) { $('comboErr').textContent = T('maxTargetsMsg'); return; }
  if (targets.length < 1) { $('comboErr').textContent = T('needTarget'); return; }
  var name = $('cName').value.trim();
  var body = {
    name: name,
    strategy: $('cStrategy').value,
    timeoutMs: Number($('cTimeout').value),
    retries: Number($('cRetries').value),
    targets: targets
  };
  if (!name) { $('comboErr').textContent = 'missing name'; return; }
  var r = await api('PUT', '/admin/api/combos/' + encodeURIComponent(name), body);
  if (r.data && r.data.ok) {
    $('comboForm').classList.add('hidden');
    showInfo(T('saved') + ': [' + name + ']');
    await boot();
  } else {
    $('comboErr').textContent = (r.data && r.data.error) ? r.data.error : (r.error || 'error');
  }
}

async function deleteCombo(name) {
  if (!window.confirm(T('confirmDel') + ' [' + name + ']?')) return;
  await api('DELETE', '/admin/api/combos/' + encodeURIComponent(name));
  await boot();
}

// ── مدل‌ها ──────────────────────────────────────────────────────────────────
function fillProviderSelects() {
  var sel = $('mProvider');
  var prev = sel.value;
  sel.textContent = '';
  CFG.providers.forEach(function (p) {
    var o = el('option', null, p.id + (p.enabled === false ? ' (off)' : ''));
    o.value = p.id;
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
}

async function searchModels() {
  var id = $('mProvider').value;
  var q = $('mQ').value.trim();
  var r = await api('GET', '/admin/api/models?provider=' + encodeURIComponent(id) + (q ? '&q=' + encodeURIComponent(q) : ''));
  var tb = $('mTbody');
  tb.textContent = '';
  var out = (r.data && r.data.models) || [];
  for (var i = 0; i < out.length; i++) {
    var m = out[i];
    var tr = el('tr');
    tr.appendChild(el('td', 'mono', m.id));
    var st = el('td', STATUS_CLASS[m.status] || '', T(STATUS_KEY[m.status]) || m.status);
    tr.appendChild(st);
    var act = el('td');
    act.appendChild(btn(T('testB'), function (mid) { return function () { testModel(id, mid); }; }(m.id)));
    tr.appendChild(act);
    tb.appendChild(tr);
  }
  $('mErr').textContent = out.length ? '' : T('noModels');
}

async function testModel(id, mid) {
  showInfo(T('testing'));
  var r = await api('POST', '/admin/api/test', { provider: id, model: mid });
  if (r.data && r.data.ok !== undefined) {
    showInfo(T('testRes') + ' [' + id + '/' + mid + '] ' + JSON.stringify(r.data));
  }
}

$('mSearch').addEventListener('click', searchModels);
$('mQ').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') searchModels(); });

$('provAdd').addEventListener('click', function () { openProviderForm(null); });
$('provSave').addEventListener('click', saveProvider);
$('provCancel').addEventListener('click', function () { $('provForm').classList.add('hidden'); });
$('comboAdd').addEventListener('click', function () { openComboForm(null); });
$('comboSave').addEventListener('click', saveCombo);
$('comboCancel').addEventListener('click', function () { $('comboForm').classList.add('hidden'); });
$('tgtAdd').addEventListener('click', function () {
  if ($('tgtBox').children.length >= TARGET_LIMIT) { $('comboErr').textContent = T('maxTargetsMsg'); return; }
  $('tgtBox').appendChild(tgtRow({}));
});

function renderAll() {
  renderProviders();
  renderCombos();
  fillProviderSelects();
  $('mTbody').textContent = '';
  $('mErr').textContent = '';
}

applyLang();
boot();
</script>
</body>
</html>`;
