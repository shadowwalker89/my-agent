// صفحه‌ی /admin — یک فایل HTML با CSS/JS داخل همان فایل (بدون فریمورک/بیلد).
// همه‌ی متن‌ها از دیکشنری I18N (en/fa) می‌آیند؛ هیچ متن خام در DOM.
// داده‌ی server فقط با textContent به DOM می‌رود (هرگز innerHTML).
// مقدار کلید provider هرگز از سرور نمی‌آید (فقط secretName) — نباید هم آمد.
export const ADMIN_HTML = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>my-agent admin</title>
<script>
(function () {
  var saved = 'system';
  try { saved = localStorage.getItem('admin_theme') || 'system'; } catch (e) {}
  var dark = saved === 'dark' || (saved !== 'light' &&
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var mode = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.style.colorScheme = mode;
})();
</script>
<style>
:root{
  color-scheme:light;
  --pad:clamp(10px,2.5vw,24px);
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;
  --r:14px;--r-sm:9px;
  --bg:#f3f5fa;--bg-soft:#f8f9fd;--card:#fff;--line:#e0e5ef;--line-strong:#ccd4e2;
  --txt:#171b24;--muted:#66708a;--acc:#2456d6;--acc-2:#1b46b5;--acc-soft:#e8eeff;--on-acc:#fff;--logo-txt:#fff;
  --ok:#0f7a37;--ok-soft:#e1f5e8;--warn:#a85b06;--warn-soft:#fcefdc;--bad:#b3261e;--bad-soft:#fde8e7;
  --muted-badge:#eef1f7;--muted-badge-txt:#5b657c;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 10px 28px rgba(16,24,40,.06);
  --focus:#6b8cff;--overlay:rgba(10,14,24,.52);
  --toast-bg:#1d2230;--toast-txt:#fff;
}
[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0d1117;--bg-soft:#151b25;--card:#151a23;--line:#283141;--line-strong:#3a4659;
  --txt:#e8ecf4;--muted:#99a5ba;--acc:#7a9cff;--acc-2:#9bb4ff;--acc-soft:#1b2740;--on-acc:#08101f;--logo-txt:#08101f;
  --ok:#5fd38a;--ok-soft:#12301f;--warn:#efb45f;--warn-soft:#382911;--bad:#ff8f86;--bad-soft:#3a1917;
  --muted-badge:#222a37;--muted-badge-txt:#a9b4c8;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 30px rgba(0,0,0,.35);
  --focus:#8aa8ff;--overlay:rgba(0,0,0,.62);
  --toast-bg:#e8ecf4;--toast-txt:#121722;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font:14px/1.55 system-ui,'Segoe UI',Vazirmatn,Tahoma,sans-serif;margin:0;padding:0 var(--pad) var(--sp-5);background:var(--bg);color:var(--txt)}
h1,h2,h3{margin:0;line-height:1.3}
h1{font-size:18px}
h2{font-size:16px}
h3{font-size:14px}
p{margin:0}
a{color:var(--acc)}
.topbar{position:sticky;top:0;z-index:40;margin:0 calc(-1 * var(--pad));padding:8px var(--pad);background:var(--bg);border-bottom:1px solid var(--line)}
.topbar-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:var(--sp-2);justify-content:space-between;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:var(--sp-2);font-weight:700;letter-spacing:.2px}
.brand-lg{font-size:17px;margin-bottom:var(--sp-4)}
.logo{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--acc);color:var(--logo-txt);font-size:13px;box-shadow:var(--shadow)}
.top-actions{display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap}
.tabs{max-width:1200px;margin:var(--sp-3) auto 0;display:flex;gap:2px;border-bottom:2px solid var(--line);overflow-x:auto;scrollbar-width:thin}
.tabs button{padding:9px 16px;border:0;border-bottom:3px solid transparent;background:none;color:var(--muted);font-size:14px;cursor:pointer;white-space:nowrap;margin-bottom:-2px}
.tabs button.on{border-bottom-color:var(--acc);color:var(--acc);font-weight:600}
.wrap{max-width:1200px;margin:0 auto;width:100%}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:clamp(var(--sp-3),2vw,var(--sp-5));margin:var(--sp-4) 0}
.subcard{background:var(--bg-soft);border:1px solid var(--line);border-radius:var(--r-sm);padding:var(--sp-3);margin:var(--sp-2) 0}
.grid{display:grid;gap:var(--sp-3);grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));align-items:start}
.help{color:var(--muted);font-size:12px;margin:var(--sp-1) 0 var(--sp-3)}
.sec-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--sp-3);margin-bottom:var(--sp-3)}
.toolbar{display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap;margin:var(--sp-2) 0}
.toolbar .grow{flex:1 1 220px}
table{border-collapse:collapse;width:100%}
th,td{padding:8px 10px;font-size:13px;text-align:start;vertical-align:top;border-bottom:1px solid var(--line)}
th{background:var(--bg-soft);font-weight:600;color:var(--muted);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
.table-wrap{max-height:72vh;overflow:auto;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--card)}
.table-wrap thead th{position:sticky;top:0;z-index:1;border-bottom:1px solid var(--line-strong)}
button{min-height:30px;margin:1px 2px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--line-strong);border-radius:7px;background:var(--card);color:var(--txt);transition:background-color .16s,border-color .16s,color .16s,box-shadow .16s}
button:hover:not(:disabled){background:var(--bg-soft);border-color:var(--acc)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--acc);border-color:var(--acc);color:var(--on-acc)}
button.primary:hover:not(:disabled){background:var(--acc-2);border-color:var(--acc-2)}
button.danger{background:var(--card);border-color:var(--bad);color:var(--bad)}
button.danger:hover:not(:disabled){background:var(--bad-soft)}
button.ghost{background:none;border-color:transparent;color:var(--acc)}
button.ghost:hover:not(:disabled){background:var(--acc-soft)}
button.lg{font-size:13px;padding:8px 16px}
button.sm{padding:2px 9px;min-height:27px}
button.block{width:100%}
input,select{min-height:32px;font:inherit;font-size:13px;padding:4px 8px;border:1px solid var(--line-strong);border-radius:7px;background:var(--card);color:var(--txt)}
input::placeholder{color:var(--muted)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.line{display:flex;gap:var(--sp-2);align-items:center;margin:var(--sp-1) 0;flex-wrap:wrap}
.stack{display:flex;flex-direction:column;gap:var(--sp-2)}
.spacer{flex:1}
.hidden{display:none!important}
.mono{font-family:ui-monospace,Consolas,monospace;direction:ltr;text-align:start;word-break:break-all}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.b-ok{background:var(--ok-soft);color:var(--ok)}
.b-cool{background:var(--warn-soft);color:var(--warn)}
.b-ban{background:var(--bad-soft);color:var(--bad)}
.b-muted{background:var(--muted-badge);color:var(--muted-badge-txt)}
.badge-wrap{display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px}
.age{color:var(--muted);font-size:11px;white-space:nowrap}
.stale{opacity:.55;filter:saturate(.65)}
.spin{display:inline-block;width:11px;height:11px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:.65}50%{opacity:1}}
.skel{height:12px;border-radius:6px;background:var(--line);animation:pulse 1.2s ease-in-out infinite}
.err{color:var(--bad);white-space:pre-wrap;margin:var(--sp-2) 0}
.state{color:var(--muted);font-size:13px;margin:var(--sp-2) 0;min-height:18px}
.lbl{color:var(--muted);font-size:12px}
.chkrow{display:inline-flex;gap:var(--sp-2);align-items:center;font-size:13px;cursor:pointer}
.chkrow input{min-height:0;width:16px;height:16px;accent-color:var(--acc)}
.progress{height:8px;background:var(--line);border-radius:999px;overflow:hidden}
.progress>div{height:100%;background:var(--acc);width:0;transition:width .2s}
.overlay{position:fixed;inset:0;background:var(--overlay);display:flex;align-items:center;justify-content:center;z-index:50;padding:var(--sp-3)}
.pop{max-width:460px;width:100%;max-height:82vh;overflow:auto}
.toasts{position:fixed;bottom:var(--sp-3);left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:var(--sp-2);z-index:60;pointer-events:none;padding:0 var(--pad)}
.toast{pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:var(--sp-3);background:var(--toast-bg);color:var(--toast-txt);padding:9px 16px;border-radius:var(--r-sm);font-size:13px;max-width:min(560px,94vw);box-shadow:0 8px 28px rgba(0,0,0,.28);border-left:4px solid var(--acc)}
.toast.okly{border-left-color:var(--ok)}
.toast.err{border-left-color:var(--bad)}
.toast-act{min-height:24px;padding:2px 8px;border-color:currentColor;background:transparent;color:inherit;font-weight:600}
.resx{font-size:22px;line-height:1}
.rescard{background:var(--bg-soft);border:1px solid var(--line);border-radius:var(--r-sm);padding:var(--sp-3);margin:var(--sp-2) 0}
.rescard.fail{border-color:var(--bad)}
.pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:7px;padding:8px;font-size:12px;margin-top:var(--sp-2)}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:8px;overflow:hidden;background:var(--bg-soft)}
.seg button{min-height:28px;margin:0;border:0;border-radius:0;background:none;color:var(--muted);padding:3px 8px;font-size:12px}
.seg button.on{background:var(--acc-soft);color:var(--acc);font-weight:600}
.seg button:hover:not(:disabled){background:var(--acc-soft)}
.pass-wrap{position:relative}
.pass-wrap input{width:100%;padding-inline-end:74px}
.eye{position:absolute;inset-inline-end:4px;top:50%;transform:translateY(-50%);min-height:26px;padding:2px 8px;font-size:12px}
.login-box{min-height:calc(100vh - 150px);display:flex;align-items:center;justify-content:center;padding:var(--sp-5) 0}
.login-card{width:min(440px,100%);margin:0}
.theme-line{justify-content:space-between;border-top:1px solid var(--line);padding-top:var(--sp-3);margin-top:var(--sp-4)}
.prov-card{display:flex;flex-direction:column;gap:var(--sp-2)}
.prov-meta{display:grid;gap:3px;font-size:12px}
.prov-meta>div{display:flex;gap:var(--sp-2);justify-content:space-between;border-bottom:1px dashed var(--line);padding-bottom:3px}
.prov-meta .mono{word-break:break-all}
.prov-actions{display:flex;gap:var(--sp-1);flex-wrap:wrap;margin-top:auto}
.prov-actions button{flex:1 1 auto}
.status-area{margin-top:var(--sp-1)}
.combo-card{display:flex;flex-direction:column;gap:var(--sp-2)}
.combo-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--sp-2);flex-wrap:wrap}
.combo-meta{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
.chips{display:flex;gap:3px;flex-wrap:wrap;margin-top:3px}
.chip{display:inline-block;padding:0 6px;border-radius:999px;background:var(--acc-soft);color:var(--acc);font-size:10px;font-weight:600;line-height:18px;white-space:nowrap}
.sync-line{margin:2px 0}
.fit-warn{opacity:.72}
.may-not-fit{font-size:11px}
.tgt-row{display:flex;gap:var(--sp-1);align-items:center;flex-wrap:wrap}
.tgt-row input.mono{flex:1 1 160px}
.empty{padding:var(--sp-5) var(--sp-3);text-align:center;color:var(--muted);border:1px dashed var(--line-strong);border-radius:var(--r-sm);background:var(--bg-soft)}
@media (max-width:700px){
  body{font-size:14px;padding-bottom:var(--sp-4)}
  .topbar-inner{gap:var(--sp-1)}
  .top-actions{width:100%;justify-content:space-between}
  .tabs{margin-top:var(--sp-2)}
  .tabs button{min-height:42px;padding:8px 12px;font-size:13px}
  .card{padding:var(--sp-3);border-radius:10px;margin:var(--sp-3) 0}
  .grid{grid-template-columns:1fr}
  .sec-head{flex-direction:column;align-items:stretch}
  .sec-head>button{width:100%}
  .toolbar>*{width:100%;margin:0}
  .toolbar .grow{flex-basis:auto}
  button,input,select{min-height:40px}
  button.sm{min-height:40px}
  .seg button{min-height:40px}
  .eye{min-height:40px}
  .table-wrap{max-height:none;border:0;background:none;overflow:visible}
  .table-wrap table,.table-wrap tbody,.table-wrap tr,.table-wrap td{display:block;width:100%}
  .table-wrap thead{display:none}
  .table-wrap tbody tr{border:1px solid var(--line);border-radius:10px;padding:var(--sp-2) var(--sp-3);margin-bottom:var(--sp-2);background:var(--card);box-shadow:var(--shadow)}
  .table-wrap td{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-3);border:0;padding:4px 0;text-align:end}
  .table-wrap td::before{content:attr(data-label);color:var(--muted);font-size:12px;font-weight:600;text-align:start}
  .table-wrap td.model-cell{font-size:13px;text-align:start}
  .table-wrap td.model-cell::before{display:none}
  .table-wrap td.model-cell .mono{word-break:break-all}
  .table-wrap td.actions-cell{flex-direction:column;align-items:stretch}
  .table-wrap td.actions-cell::before{margin-bottom:2px}
  .table-wrap td .actions{display:flex;gap:var(--sp-1);flex-wrap:wrap}
  .table-wrap td .actions button{flex:1 1 auto}
  .prov-actions button{flex:1 1 46%}
  .tgt-row>*{flex:1 1 auto}
  .tgt-row input.mono{flex-basis:100%}
  .theme-line{flex-direction:column;align-items:stretch}
  .login-box{min-height:calc(100vh - 190px);padding:var(--sp-4) 0}
  .toasts{bottom:var(--sp-2)}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand"><span class="logo" aria-hidden="true">&#9670;</span><span>my-agent</span></div>
    <div class="top-actions">
      <div class="seg" id="themeHeader" role="group" data-i18n-aria="themeLabel">
        <button type="button" data-theme-set="system" data-i18n="themeSystem"></button>
        <button type="button" data-theme-set="light" data-i18n="themeLight"></button>
        <button type="button" data-theme-set="dark" data-i18n="themeDark"></button>
      </div>
      <button id="langBtn" class="ghost" data-i18n="langBtn"></button>
      <button id="logoutBtn" class="ghost hidden" data-i18n="logout"></button>
    </div>
  </div>
</header>
<div id="toasts" class="toasts" aria-live="polite"></div>
<nav id="tabs" class="tabs hidden" data-i18n-aria="sectionsLabel">
  <button type="button" id="tabBtnProv" data-tab="provTab" data-i18n="tabProviders"></button>
  <button type="button" id="tabBtnModels" data-tab="modelsTab" data-i18n="tabModels"></button>
  <button type="button" id="tabBtnCombos" data-tab="combosTab" data-i18n="tabCombos"></button>
</nav>

<main class="wrap">
  <div id="loginBox" class="login-box">
    <section class="card login-card">
      <div class="brand brand-lg"><span class="logo" aria-hidden="true">&#9670;</span><span data-i18n="title"></span></div>
      <h2 data-i18n="loginTitle"></h2>
      <p class="help" data-i18n="loginHelp"></p>
      <form id="loginForm" class="stack" novalidate>
        <label class="lbl" for="loginKey" data-i18n="adminKey"></label>
        <div class="pass-wrap">
          <input type="password" id="loginKey" autocomplete="current-password" required autofocus>
          <button type="button" id="eyeBtn" class="eye" data-i18n="showKey"></button>
        </div>
        <button type="submit" id="loginGo" class="primary lg block" data-i18n="login"></button>
      </form>
      <div id="loginErr" class="err" role="alert"></div>
      <div class="line theme-line">
        <span class="lbl" data-i18n="themeLabel"></span>
        <div class="seg" id="themeLogin" role="group" data-i18n-aria="themeLabel">
          <button type="button" data-theme-set="system" data-i18n="themeSystem"></button>
          <button type="button" data-theme-set="light" data-i18n="themeLight"></button>
          <button type="button" data-theme-set="dark" data-i18n="themeDark"></button>
        </div>
      </div>
    </section>
  </div>

  <div id="appBox" class="hidden">
    <section id="provTab" class="tab">
      <div class="card">
        <div class="sec-head">
          <div><h2 data-i18n="providers"></h2><p class="help" data-i18n="provHelp"></p></div>
          <button id="provAdd" class="primary lg" data-i18n="provAdd"></button>
        </div>
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
        <div id="provGrid" class="grid prov-grid"></div>
      </div>
    </section>

    <section id="modelsTab" class="tab hidden">
      <div class="card">
        <div class="sec-head"><div><h2 data-i18n="models"></h2><p class="help" data-i18n="modelsHelp"></p></div></div>
        <div class="toolbar">
          <span class="lbl" data-i18n="providerCol"></span><select id="mProvider"></select>
          <input id="mQ" class="mono grow" data-i18n-ph="qPh">
          <select id="mStatus">
            <option value="all" data-i18n="stAll"></option>
            <option value="ok" data-i18n="stOk"></option>
            <option value="cooldown" data-i18n="stCooldown"></option>
            <option value="banned" data-i18n="stBanned"></option>
          </select>
          <select id="mCap" data-i18n-aria="capLabel">
            <option value="all" data-i18n="stAll"></option>
            <option value="vision" data-i18n="tagVision"></option>
            <option value="reasoning" data-i18n="tagReasoning"></option>
            <option value="coder" data-i18n="tagCoder"></option>
            <option value="embedding" data-i18n="tagEmbedding"></option>
            <option value="image-gen" data-i18n="tagImageGen"></option>
            <option value="fast" data-i18n="tagFast"></option>
          </select>
          <button id="mSearch" class="primary" data-i18n="search"></button>
          <button id="mTestAll" class="primary"></button>
          <button id="mStop" class="danger hidden" data-i18n="stopBtn"></button>
        </div>
        <div class="toolbar">
          <label class="chkrow"><input type="checkbox" id="mOnlyOk"><span data-i18n="showOnlyOk"></span></label>
          <label class="chkrow"><input type="checkbox" id="mOnlyUntested"><span data-i18n="onlyUntested"></span></label>
          <span class="spacer"></span>
          <button id="mClearProv" class="sm" data-i18n="clearProvResults"></button>
          <button id="mClearAll" class="sm danger" data-i18n="clearAllResults"></button>
        </div>
        <div id="mProgress" class="hidden">
          <div class="progress"><div id="mBar"></div></div>
          <div id="mCount" class="lbl"></div>
        </div>
        <div id="mErr" class="state" role="status"></div>
        <div id="mResult"></div>
        <div class="table-wrap">
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
        <div class="sec-head">
          <div><h2 data-i18n="combos"></h2><p class="help" data-i18n="combosHelp"></p></div>
          <button id="comboAdd" class="primary lg" data-i18n="comboAdd"></button>
        </div>
        <div class="toolbar" id="comboTemplates">
          <span class="lbl" data-i18n="templatesLabel"></span>
          <button type="button" data-template="code" data-i18n="kindCode" data-i18n-aria="createTemplate"></button>
          <button type="button" data-template="vision" data-i18n="kindVision" data-i18n-aria="createTemplate"></button>
          <button type="button" data-template="fast" data-i18n="kindFast" data-i18n-aria="createTemplate"></button>
          <button type="button" data-template="reasoning" data-i18n="kindReasoning" data-i18n-aria="createTemplate"></button>
        </div>
        <div class="sec-head">
          <div><h3 data-i18n="autoCombos"></h3><p class="help" data-i18n="autoHelp"></p></div>
        </div>
        <div id="autoList" class="grid combo-grid"></div>
        <div class="sec-head">
          <div><h3 data-i18n="manualCombos"></h3></div>
        </div>
        <div id="comboForm" class="subcard hidden">
          <h3 id="comboFormTitle"></h3>
          <div class="line">
            <span class="lbl" data-i18n="comboName"></span><input id="cName" maxlength="40" class="mono">
            <span class="lbl" data-i18n="kindLabel"></span>
            <select id="cKind">
              <option value="text" data-i18n="kindText"></option>
              <option value="code" data-i18n="kindCode"></option>
              <option value="vision" data-i18n="kindVision"></option>
              <option value="reasoning" data-i18n="kindReasoning"></option>
              <option value="fast" data-i18n="kindFast"></option>
              <option value="custom" data-i18n="kindCustom"></option>
            </select>
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
        <div id="comboList" class="grid combo-grid"></div>
      </div>
    </section>
  </div>
</main>
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
    maxLimitReached: 'Max 30 targets reached.',
    loginHelp: 'Enter the admin key to manage providers, models and combos.',
    adminKey: 'Admin key',
    loginInvalid: 'Invalid key. Try again.',
    loggingIn: 'Signing in...',
    showKey: 'Show',
    hideKey: 'Hide',
    themeLabel: 'Theme',
    sectionsLabel: 'Sections',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    onlyUntested: 'Only untested/stale',
    clearAllResults: 'Clear all results',
    clearProvResults: 'Clear this provider',
    clearConfirmAll: 'Clear all saved test results?',
    clearConfirmProv: 'Clear saved test results for this provider?',
    clearedResults: 'Results cleared',
    untested: 'untested',
    testedAgo: 'tested',
    stale: 'stale',
    justNow: 'just now',
    minAgo: 'min ago',
    hoursAgo: 'h ago',
    daysAgo: 'd ago',
    nothingToTest: 'Nothing to test with the current filters.',
    loadFail: 'Could not load models.',
    loading: 'Loading...',
    modelsAvailable: 'Models available',
    modelsSynced: 'Models synced',
    addedLabel: 'Added',
    removedLabel: 'Removed',
    lastSync: 'Last sync',
    checked: 'Checked',
    noRecent: 'No recent test or refresh.',
    noCombos: 'No combos yet. Create one to order fallback targets.',
    addComboTitle: 'Add target to combo',
    createCombo: 'Create combo',
    createAndAdd: 'Create & add',
    comboNamePh: 'combo name',
    goToCombo: 'Go to combo',
    moveUp: 'Move up',
    moveDown: 'Move down',
    summaryProvider: 'Provider',
    stoppedEarly: 'stopped early',
    refreshB: 'refresh',
    clearResults: 'Clear results',
    kindLabel: 'Kind',
    kindText: 'Text',
    kindCode: 'Code',
    kindVision: 'Vision',
    kindReasoning: 'Reasoning',
    kindFast: 'Fast',
    kindCustom: 'Custom',
    capLabel: 'Capability',
    tagVision: 'vision',
    tagReasoning: 'reasoning',
    tagCoder: 'coder',
    tagEmbedding: 'embedding',
    tagImageGen: 'image-gen',
    tagFast: 'fast',
    mayNotFit: 'may not fit',
    templatesLabel: 'Templates',
    createTemplate: 'Create from template',
    templateCreated: 'Template combo created',
    fillFromTested: 'Fill from tested-OK',
    fillCount: 'Count',
    fillNone: 'No fresh tested-OK models match this combo kind.',
    syncKept: 'kept',
    syncDropped: 'dropped',
    syncNoData: 'not synced yet',
    autoCombos: 'Auto combos',
    autoHelp: 'Built-in rule-based combos pick fresh models from the catalog on every run — read-only here.',
    autoBadge: 'auto',
    autoReadonly: 'Built-in — targets are picked automatically from the catalog.',
    createManualCopy: 'Create manual copy',
    copyCreated: 'Manual copy created',
    copyExists: 'A manual combo with this name already exists.',
    copyEmpty: 'No usable targets right now — refresh the catalog first.',
    manualCombos: 'Manual combos',
    saving: 'Saving...'
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
    maxLimitReached: 'سقف ۳۰ هدف پر شد.',
    loginHelp: 'برای مدیریت providerها، مدل‌ها و comboها کلید مدیر را وارد کن.',
    adminKey: 'کلید مدیر',
    loginInvalid: 'کلید نامعتبر است. دوباره امتحان کن.',
    loggingIn: 'در حال ورود...',
    showKey: 'نمایش',
    hideKey: 'پنهان',
    themeLabel: 'تم',
    sectionsLabel: 'بخش‌ها',
    themeSystem: 'سیستم',
    themeLight: 'روشن',
    themeDark: 'تیره',
    onlyUntested: 'فقط تست‌نشده/کهنه',
    clearAllResults: 'پاک کردن همه‌ی نتایج',
    clearProvResults: 'پاک کردن این provider',
    clearConfirmAll: 'همه‌ی نتایج تست ذخیره‌شده پاک شود؟',
    clearConfirmProv: 'نتایج تست ذخیره‌شده‌ی این provider پاک شود؟',
    clearedResults: 'نتایج پاک شد',
    untested: 'تست‌نشده',
    testedAgo: 'تست‌شده',
    stale: 'کهنه',
    justNow: 'همین الان',
    minAgo: 'دقیقه پیش',
    hoursAgo: 'ساعت پیش',
    daysAgo: 'روز پیش',
    nothingToTest: 'با این فیلتر چیزی برای تست نیست.',
    loadFail: 'بارگیری مدل‌ها ناموفق بود.',
    loading: 'در حال بارگیری...',
    modelsAvailable: 'مدل‌های موجود',
    modelsSynced: 'مدل‌های همگام‌شده',
    addedLabel: 'افزوده',
    removedLabel: 'حذف‌شده',
    lastSync: 'آخرین همگام‌سازی',
    checked: 'بررسی‌شده',
    noRecent: 'تست یا به‌روزرسانی تازه‌ای نیست.',
    noCombos: 'هنوز comboی نیست. برای ترتیب هدف‌های جایگزین یکی بساز.',
    addComboTitle: 'افزودن هدف به combo',
    createCombo: 'ساختن combo',
    createAndAdd: 'بساز و اضافه کن',
    comboNamePh: 'نام combo',
    goToCombo: 'رفتن به combo',
    moveUp: 'بالا',
    moveDown: 'پایین',
    summaryProvider: 'Provider',
    stoppedEarly: 'نیمه‌کاره متوقف شد',
    refreshB: 'به‌روزرسانی',
    clearResults: 'پاک کردن نتایج',
    kindLabel: 'نوع',
    kindText: 'متنی',
    kindCode: 'کد',
    kindVision: 'ویژن',
    kindReasoning: 'استدلال',
    kindFast: 'سریع',
    kindCustom: 'سفارشی',
    capLabel: 'قابلیت',
    tagVision: 'ویژن',
    tagReasoning: 'استدلال',
    tagCoder: 'کد',
    tagEmbedding: 'امبدینگ',
    tagImageGen: 'تولید تصویر',
    tagFast: 'سریع',
    mayNotFit: 'ممکن است مناسب نباشد',
    templatesLabel: 'قالب‌ها',
    createTemplate: 'ساختن از قالب',
    templateCreated: 'combo قالبی ساخته شد',
    fillFromTested: 'پر کردن از تست‌شده‌های سالم',
    fillCount: 'تعداد',
    fillNone: 'هیچ مدل تست‌شده‌ی سالم و تازه‌ای مناسب این نوع combo نیست.',
    syncKept: 'نگه‌داشته',
    syncDropped: 'حذف‌شده',
    syncNoData: 'هنوز همگام نشده',
    autoCombos: 'comboهای خودکار',
    autoHelp: 'comboهای داخلیِ قانون‌محور هر بار مدل‌های تازه را از کاتالوگ انتخاب می‌کنند — اینجا فقط‌خواندنی‌اند.',
    autoBadge: 'خودکار',
    autoReadonly: 'داخلی — هدف‌ها هر بار خودکار از کاتالوگ انتخاب می‌شوند.',
    createManualCopy: 'ساخت نسخه‌ی دستی',
    copyCreated: 'نسخه‌ی دستی ساخته شد',
    copyExists: 'یک combo دستی با همین نام از قبل هست.',
    copyEmpty: 'الان هدفِ سالمی نیست — اول کاتالوگ را به‌روزرسانی کن.',
    manualCombos: 'comboهای دستی',
    saving: 'در حال ذخیره...'
  }
};
var STATUS_KEY = { ok: 'stOk', cooldown: 'stCooldown', banned: 'stBanned' };
var STATUS_CLASS = { ok: 'b-ok', cooldown: 'b-cool', banned: 'b-ban' };
var LABEL_KEYS = { timeout: 'lblTimeout', auth: 'lblAuth', notfound: 'lblNotFound', ratelimit: 'lblRate', server: 'lblServer', unknown: 'lblUnknown' };
var CAP_TAGS = ['vision', 'reasoning', 'coder', 'embedding', 'image-gen', 'fast'];
var CAP_KEY = { vision: 'tagVision', reasoning: 'tagReasoning', coder: 'tagCoder', embedding: 'tagEmbedding', 'image-gen': 'tagImageGen', fast: 'tagFast' };
var KIND_KEYS = { text: 'kindText', code: 'kindCode', vision: 'kindVision', reasoning: 'kindReasoning', fast: 'kindFast', custom: 'kindCustom' };
var AUTO_COMBOS = ['chat', 'code', 'vision', 'fast'];
var AUTO_KINDS = { chat: 'text', code: 'code', vision: 'vision', fast: 'fast' };
var KIND_TAG = { text: null, code: 'coder', vision: 'vision', reasoning: 'reasoning', fast: 'fast', custom: null };
var TARGET_LIMIT = 30;
var TEST_ALL_CONCURRENCY = 3;
var TEST_ALL_CAP = 60;
var RESULT_CAP = 500;
var STALE_MS = 24 * 60 * 60 * 1000;
var LS_THEME = 'admin_theme';
var LS_RESULTS = 'admin_test_results_v1';
var LS_MODELS = 'admin_models_state_v1';
var LS_PROV = 'admin_provider_status_v1';

function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch (e) {}
}
function readJson(key) {
  try { return JSON.parse(lsGet(key) || 'null'); } catch (e) { return null; }
}

var lang;
try { lang = (localStorage.getItem('admin_lang') === 'fa') ? 'fa' : 'en'; } catch (e) { lang = 'en'; }
var TABS = ['provTab', 'modelsTab', 'combosTab'];
var CFG = null;
var CUR_MODELS = [];
var CUR_PROVIDER = '';
var ROW_ELS = {};
var PROV_ELS = {};
var PROV_BUSY = {};
var runActive = false;
var runStopping = false;
var activeTab = null;
var APPLIED_KEY = '';
var TAB_SCROLL = (function () {
  try {
    var raw = JSON.parse(sessionStorage.getItem('admin_tab_scroll_v1') || '{}');
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (e) { return {}; }
})();
var searchSeq = 0;
var SYNC_INFO = {};
var TAGS_CACHE = {};

function saveTabScroll() {
  try { sessionStorage.setItem('admin_tab_scroll_v1', JSON.stringify(TAB_SCROLL)); } catch (e) {}
}
window.addEventListener('beforeunload', function () {
  if (!activeTab) return;
  TAB_SCROLL[activeTab] = window.scrollY;
  saveTabScroll();
});

var RESULTS = loadResults();
var PROV_STATUS = loadProvStatus();
var MODEL_STATE = loadModelState();
var themeChoice = (function () {
  var v = lsGet(LS_THEME);
  return (v === 'light' || v === 'dark' || v === 'system') ? v : 'system';
})();

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

var TAG_PATTERNS = {
  vision: /vision|\bvl\b|omni/i,
  reasoning: /\br1\b|reasoning|thinking/i,
  coder: /coder|code/i,
  embedding: /embed/i,
  'image-gen': /\bimage[-_]?gen|dall[-_ ]?e|flux|stable[-_ ]?diffusion|sdxl|\bimagen\b|gpt-image|midjourney/i,
  fast: /\b(flash|mini|nano|lite|small)\b/i
};
function inferTags(id) {
  var out = [];
  CAP_TAGS.forEach(function (tag) {
    if (TAG_PATTERNS[tag] && TAG_PATTERNS[tag].test(String(id || ''))) out.push(tag);
  });
  return out;
}
function modelTags(m) {
  return (m && Array.isArray(m.tags)) ? m.tags : inferTags(m && m.id);
}
function tagsForModel(prov, model) {
  if (prov === CUR_PROVIDER) {
    for (var i = 0; i < CUR_MODELS.length; i++) {
      if (CUR_MODELS[i].id === model) return modelTags(CUR_MODELS[i]);
    }
  }
  var cache = TAGS_CACHE[prov];
  if (cache && Array.isArray(cache[prov + '/' + model])) return cache[prov + '/' + model];
  return inferTags(model);
}
function tagKey(tag) { return CAP_KEY[tag] || tag; }
function kindKey(kind) { return KIND_KEYS[kind] || KIND_KEYS.custom; }
function suggestKind(tags) {
  if (tags.indexOf('vision') >= 0) return 'vision';
  if (tags.indexOf('coder') >= 0) return 'code';
  if (tags.indexOf('reasoning') >= 0) return 'reasoning';
  if (tags.indexOf('fast') >= 0) return 'fast';
  return 'text';
}
function kindCompatible(kind, tags) {
  if (tags.indexOf('embedding') >= 0 || tags.indexOf('image-gen') >= 0) return false;
  var need = KIND_TAG[kind] || null;
  if (!need || kind === 'custom') return true;
  return tags.indexOf(need) >= 0;
}
function comboFit(kind, tags) {
  var bad = tags.indexOf('embedding') >= 0 || tags.indexOf('image-gen') >= 0;
  if (bad) return { level: 'warn', mayNotFit: true };
  var need = KIND_TAG[kind] || null;
  if (!need || kind === 'text' || kind === 'custom') return { level: 'generic', mayNotFit: false };
  if (tags.indexOf(need) >= 0) return { level: 'match', mayNotFit: false };
  return { level: 'warn', mayNotFit: true };
}
function orderedCombos(combos, tags) {
  var rank = { match: 0, generic: 1, warn: 2 };
  return (combos || []).map(function (combo, index) {
    return { combo: combo, index: index, fit: comboFit(combo.kind || 'custom', tags) };
  }).sort(function (a, b) {
    return rank[a.fit.level] - rank[b.fit.level] || a.index - b.index;
  });
}
function autoFillCandidates(results, kind, limit, existing, tagsByKey) {
  var n = Math.max(0, Math.min(30, Math.floor(Number(limit) || 0)));
  if (!n) return [];
  var seen = {};
  (existing || []).forEach(function (t) { seen[t.provider + '/' + t.model] = true; });
  var out = [];
  Object.keys(results || {}).forEach(function (key) {
    var value = results[key];
    if (!value || value.ok !== true) return;
    if (typeof value.testedAt !== 'number' || Date.now() - value.testedAt > STALE_MS) return;
    var slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1 || seen[key]) return;
    var provider = key.slice(0, slash);
    var model = key.slice(slash + 1);
    var tags = Array.isArray(tagsByKey[key]) ? tagsByKey[key] : inferTags(model);
    if (!kindCompatible(kind, tags)) return;
    out.push({
      key: key, provider: provider, model: model,
      latencyMs: (typeof value.latencyMs === 'number') ? value.latencyMs : null
    });
  });
  out.sort(function (a, b) {
    var al = (a.latencyMs === null) ? Infinity : a.latencyMs;
    var bl = (b.latencyMs === null) ? Infinity : b.latencyMs;
    return al - bl || a.key.localeCompare(b.key);
  });
  return out.slice(0, n);
}

async function loadTagsForProviders(providers) {
  await Promise.all(providers.map(async function (p) {
    if (TAGS_CACHE[p]) return;
    var r = await api('GET', '/admin/api/models?provider=' + encodeURIComponent(p), undefined, { quiet: true });
    if (r.data && r.data.ok) {
      var map = {};
      (r.data.models || []).forEach(function (m) {
        map[p + '/' + m.id] = Array.isArray(m.tags) ? m.tags : inferTags(m.id);
      });
      TAGS_CACHE[p] = map;
    } else {
      TAGS_CACHE[p] = {};
    }
  }));
}

function loadResults() {
  var raw = readJson(LS_RESULTS);
  var out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      if (!v || typeof v !== 'object' || typeof v.testedAt !== 'number') return;
      out[k] = {
        ok: v.ok === true,
        status: (typeof v.status === 'number') ? v.status : null,
        latencyMs: (typeof v.latencyMs === 'number') ? v.latencyMs : null,
        label: v.label ? String(v.label) : null,
        text: String(v.text || '').slice(0, 200),
        testedAt: v.testedAt
      };
    });
  }
  return capResults(out);
}
function capResults(obj) {
  var keys = Object.keys(obj).sort(function (a, b) { return obj[b].testedAt - obj[a].testedAt; });
  var out = {};
  keys.slice(0, RESULT_CAP).forEach(function (k) { out[k] = obj[k]; });
  return out;
}
function saveResults() {
  RESULTS = capResults(RESULTS);
  lsSet(LS_RESULTS, JSON.stringify(RESULTS));
}
function setResult(provider, model, data) {
  RESULTS[provider + '/' + model] = {
    ok: data.ok === true,
    status: (typeof data.status === 'number') ? data.status : null,
    latencyMs: (typeof data.latencyMs === 'number') ? data.latencyMs : null,
    label: data.label ? String(data.label) : null,
    text: String(data.text || data.snippet || '').slice(0, 200),
    testedAt: Date.now()
  };
  saveResults();
}
function resultFor(provider, model) {
  return RESULTS[provider + '/' + model] || null;
}
function isStale(r) {
  return !r || (Date.now() - r.testedAt) > STALE_MS;
}

function loadModelState() {
  var s = { provider: '', q: '', status: 'all', cap: 'all', onlyOk: false, onlyUntested: false, summary: null };
  var raw = readJson(LS_MODELS);
  if (raw && typeof raw === 'object') {
    if (typeof raw.provider === 'string') s.provider = raw.provider;
    if (typeof raw.q === 'string') s.q = raw.q;
    if (['all', 'ok', 'cooldown', 'banned'].indexOf(raw.status) >= 0) s.status = raw.status;
    if (raw.cap === 'all' || CAP_TAGS.indexOf(raw.cap) >= 0) s.cap = raw.cap;
    s.onlyOk = raw.onlyOk === true;
    s.onlyUntested = raw.onlyUntested === true;
    if (raw.summary && typeof raw.summary === 'object') s.summary = raw.summary;
  }
  return s;
}
function saveModelState() { lsSet(LS_MODELS, JSON.stringify(MODEL_STATE)); }

function loadProvStatus() {
  var raw = readJson(LS_PROV);
  return (raw && typeof raw === 'object') ? raw : {};
}
function saveProvStatus() { lsSet(LS_PROV, JSON.stringify(PROV_STATUS)); }

function ago(ts) {
  if (!ts) return T('justNow');
  var diff = Math.max(0, Date.now() - ts);
  var m = Math.floor(diff / 60000);
  if (m < 1) return T('justNow');
  if (m < 60) return m + ' ' + T('minAgo');
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' ' + T('hoursAgo');
  return Math.floor(h / 24) + ' ' + T('daysAgo');
}

function systemDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function resolvedTheme() {
  return themeChoice === 'system' ? (systemDark() ? 'dark' : 'light') : themeChoice;
}
function applyTheme() {
  var mode = resolvedTheme();
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.style.colorScheme = mode;
  updateThemeButtons();
}
function setTheme(v) {
  if (v !== 'light' && v !== 'dark' && v !== 'system') v = 'system';
  themeChoice = v;
  lsSet(LS_THEME, v);
  applyTheme();
}
function updateThemeButtons() {
  var nodes = document.querySelectorAll('[data-theme-set]');
  for (var i = 0; i < nodes.length; i++) {
    var on = nodes[i].getAttribute('data-theme-set') === themeChoice;
    nodes[i].classList.toggle('on', on);
    nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
if (window.matchMedia) {
  var themeMq = window.matchMedia('(prefers-color-scheme: dark)');
  var onThemeMq = function () { if (themeChoice === 'system') applyTheme(); };
  if (themeMq.addEventListener) themeMq.addEventListener('change', onThemeMq);
  else if (themeMq.addListener) themeMq.addListener(onThemeMq);
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'fa') ? 'rtl' : 'ltr';
  lsSet('admin_lang', lang);
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
  nodes = document.querySelectorAll('[data-i18n-ph]');
  for (var j = 0; j < nodes.length; j++) nodes[j].placeholder = T(nodes[j].getAttribute('data-i18n-ph'));
  nodes = document.querySelectorAll('[data-i18n-aria]');
  for (var k = 0; k < nodes.length; k++) nodes[k].setAttribute('aria-label', T(nodes[k].getAttribute('data-i18n-aria')));
  document.title = T('title');
  updateEye();
  updateThemeButtons();
  if (CFG) {
    renderProviders();
    renderCombos();
    renderAutoCombos();
    fillProviderSelects();
    renderRows();
    renderSummary();
  }
}

function toast(msg, kind, action) {
  var t = el('div', 'toast ' + (kind || ''));
  t.appendChild(el('span', null, String(msg)));
  var hide = function () { t.remove(); };
  if (action) {
    t.appendChild(btn(action.label, function (ev) {
      ev.stopPropagation();
      hide();
      if (action.fn) action.fn();
    }, 'toast-act'));
  }
  t.addEventListener('click', hide);
  $('toasts').appendChild(t);
  setTimeout(hide, action ? 7000 : 4200);
}

function busy(btnEl, labelKey) {
  if (!btnEl || btnEl.dataset.busy) return;
  btnEl.dataset.busy = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '';
  btnEl.appendChild(el('span', 'spin'));
  btnEl.appendChild(document.createTextNode(' ' + T(labelKey || 'testing')));
}
function idle(btnEl) {
  if (!btnEl || !btnEl.dataset.busy) return;
  btnEl.disabled = false;
  btnEl.textContent = btnEl.dataset.busy;
  delete btnEl.dataset.busy;
}

async function api(method, url, body, opts) {
  opts = opts || {};
  var opt = { method: method };
  if (body !== undefined) {
    opt.headers = { 'content-type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  var res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    if (!opts.quiet) toast(String(e), 'err');
    return { status: 0, data: null, error: String(e) };
  }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) {
    showLogin();
    if (!opts.quiet) toast((data && data.error) ? data.error : T('loginFail'), 'err');
    return { status: 401, data: data, error: (data && data.error) || 'unauthorized' };
  }
  if (res.ok === false) {
    var msg = (data && data.error) ? data.error : ('http ' + res.status);
    if (!opts.quiet) toast(msg, 'err');
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
  $('loginKey').focus();
}
function showApp() {
  $('loginBox').classList.add('hidden');
  $('tabs').classList.remove('hidden');
  $('appBox').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
}

function restoreTabScroll(id) {
  var y = TAB_SCROLL[id] || 0;
  requestAnimationFrame(function () { window.scrollTo(0, y); });
}
function showTab(id) {
  if (TABS.indexOf(id) < 0) id = 'provTab';
  if (activeTab && activeTab !== id) {
    TAB_SCROLL[activeTab] = window.scrollY;
    saveTabScroll();
  }
  activeTab = id;
  lsSet('admin_tab', id);
  var map = { provTab: 'tabBtnProv', modelsTab: 'tabBtnModels', combosTab: 'tabBtnCombos' };
  TABS.forEach(function (t) { $(t).classList.toggle('hidden', t !== id); });
  TABS.forEach(function (t) { $(map[t]).classList.toggle('on', t === id); });
  if (id === 'modelsTab') ensureModels().then(function () { restoreTabScroll(id); });
  else restoreTabScroll(id);
}

$('logoutBtn').addEventListener('click', async function () {
  await api('POST', '/admin/logout', undefined, { quiet: true });
  showLogin();
});

function updateEye() {
  var input = $('loginKey');
  var b = $('eyeBtn');
  if (!input || !b) return;
  var hidden = input.type === 'password';
  b.textContent = hidden ? T('showKey') : T('hideKey');
  b.setAttribute('aria-label', hidden ? T('showKey') : T('hideKey'));
}
$('eyeBtn').addEventListener('click', function () {
  var input = $('loginKey');
  input.type = input.type === 'password' ? 'text' : 'password';
  updateEye();
});

$('loginForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var go = $('loginGo');
  var key = $('loginKey').value;
  $('loginKey').value = '';
  $('loginErr').textContent = '';
  busy(go, 'loggingIn');
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
  } else if (res.status === 401) {
    $('loginErr').textContent = T('loginInvalid');
  } else {
    $('loginErr').textContent = (data && data.error) ? data.error : T('loginFail');
  }
});

async function createTemplateCombo(kind) {
  if (!CFG || !KIND_KEYS[kind]) return;
  var name = kind;
  var n = 2;
  while ((CFG.combos || []).some(function (c) { return c.name === name; })) {
    name = kind + '-' + n;
    n++;
  }
  var r = await api('POST', '/admin/api/combos', {
    name: name, kind: kind, strategy: 'priority', timeoutMs: 20000, retries: 0, targets: []
  }, { quiet: true });
  if (r.data && r.data.ok) {
    toast('[' + name + '] ' + T('templateCreated'), 'okly');
    await refreshCfg();
  } else {
    toast(r.error || T('loginFail'), 'err');
  }
}

async function boot() {
  var r = await api('GET', '/admin/api/config', undefined, { quiet: true });
  if (r.data && r.data.ok) {
    CFG = r.data;
    showApp();
    renderProviders();
    renderCombos();
    renderAutoCombos();
    fillProviderSelects();
    applyModelStateToInputs();
    renderRows();
    renderSummary();
    showTab(lsGet('admin_tab') || 'provTab');
  } else if (r.status !== 401) {
    showLogin();
    $('loginErr').textContent = r.error || T('loginFail');
  }
}

async function refreshCfg() {
  var r = await api('GET', '/admin/api/config', undefined, { quiet: true });
  if (r.data && r.data.ok) {
    CFG = r.data;
    renderProviders();
    renderCombos();
    renderAutoCombos();
    fillProviderSelects();
  }
}

// ── نتیجه‌کارت ──────────────────────────────────────────────────────────────
function labelCode(r) {
  if (!r || r.ok !== false) return null;
  if (r.label && LABEL_KEYS[r.label]) return r.label;
  var snippet = String(r.text || r.snippet || '');
  if (snippet.indexOf('timeout') === 0) return 'timeout';
  if (r.status === 401 || r.status === 403) return 'auth';
  if (r.status === 404) return 'notfound';
  if (r.status === 429) return 'ratelimit';
  if (typeof r.status === 'number' && r.status >= 500) return 'server';
  return 'unknown';
}
function labelText(r) {
  var code = labelCode(r);
  return code ? T(LABEL_KEYS[code]) : '';
}

function resultCard(r, name) {
  var c = el('div', 'rescard' + (r.ok === false ? ' fail' : ''));
  var head = el('div', 'line');
  head.appendChild(el('span', 'resx', r.ok ? '\u2705' : '\u274c'));
  head.appendChild(el('strong', 'mono', name));
  if (r.latencyMs !== null && r.latencyMs !== undefined) head.appendChild(el('span', 'lbl', secs(r.latencyMs)));
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
function metaRow(label, value, cls) {
  var row = el('div');
  row.appendChild(el('span', 'lbl', label));
  row.appendChild(el('span', cls || null, value));
  return row;
}

function renderProviders() {
  var grid = $('provGrid');
  grid.textContent = '';
  PROV_ELS = {};
  if (!CFG || !CFG.providers.length) return;
  CFG.providers.forEach(function (p) {
    var card = el('div', 'card prov-card');
    var head = el('div', 'line');
    head.appendChild(el('strong', 'mono', p.id));
    if (p.name) head.appendChild(el('span', 'lbl', p.name));
    if (p.builtin) head.appendChild(el('span', 'badge b-muted', T('builtinNote')));
    card.appendChild(head);

    var meta = el('div', 'prov-meta');
    meta.appendChild(metaRow(T('baseUrl'), p.baseUrl || '', 'mono'));
    meta.appendChild(metaRow(T('secretName'), p.secretName || '', 'mono'));
    meta.appendChild(metaRow(T('secretPresent'), p.secretName ? '\u2705 ' + T('yes') : '\u274c ' + T('no')));
    meta.appendChild(metaRow(T('enabledCol'), (p.enabled === false) ? T('off') : T('on')));
    card.appendChild(meta);
    var syncLine = el('div', 'lbl sync-line', T('syncNoData'));
    card.appendChild(syncLine);

    var act = el('div', 'prov-actions');
    var bTest = btn(T('testB'), function () { testProvider(p.id); }, 'sm');
    var bRefresh = btn('\u21bb ' + T('refresh'), function () { refreshProvider(p.id); }, 'sm');
    var bEdit = btn(T('editProvider'), function () { openProviderForm(p.id); }, 'sm');
    var bDel = btn(T('del'), function () { deleteProvider(p.id); }, 'sm danger');
    if (p.builtin) {
      bDel.disabled = true;
      bDel.title = T('builtinNote');
    }
    act.appendChild(bTest);
    act.appendChild(bRefresh);
    act.appendChild(bEdit);
    act.appendChild(bDel);
    card.appendChild(act);

    var status = el('div', 'status-area');
    card.appendChild(status);
    PROV_ELS[p.id] = { test: bTest, refresh: bRefresh, edit: bEdit, del: bDel, status: status, sync: syncLine, builtin: Boolean(p.builtin) };
    grid.appendChild(card);
    renderProvStatus(p.id);
    renderSyncLine(p.id);
    loadSyncInfo(p.id);
  });
}

async function loadSyncInfo(id, force) {
  if (!force && Object.prototype.hasOwnProperty.call(SYNC_INFO, id)) {
    renderSyncLine(id);
    return;
  }
  var r = await api('GET', '/admin/api/providers/' + encodeURIComponent(id) + '/sync-report', undefined, { quiet: true });
  if (r.data && r.data.ok) {
    SYNC_INFO[id] = {
      fetched: (typeof r.data.fetched === 'number') ? r.data.fetched : null,
      kept: (typeof r.data.kept === 'number') ? r.data.kept : null,
      dropped: (typeof r.data.droppedCount === 'number') ? r.data.droppedCount : null,
      at: r.data.at || null
    };
  } else if (r.status !== 401) {
    SYNC_INFO[id] = null;
  }
  renderSyncLine(id);
}

function renderSyncLine(id) {
  var e = PROV_ELS[id];
  if (!e || !e.sync) return;
  var s = SYNC_INFO[id];
  if (!s) { e.sync.textContent = T('syncNoData'); return; }
  if (typeof s.fetched === 'number' && typeof s.kept === 'number') {
    e.sync.textContent = T('syncKept') + ' ' + s.kept + '/' + s.fetched + ' · ' + T('syncDropped') + ' ' + (s.dropped || 0);
  } else {
    e.sync.textContent = T('syncKept') + ' ' + (s.kept === null ? '?' : s.kept);
  }
}

function setProvButtons(id, on) {
  var e = PROV_ELS[id];
  if (!e) return;
  e.test.disabled = on;
  e.refresh.disabled = on;
  e.edit.disabled = on;
  e.del.disabled = on || e.builtin;
}

function renderProvStatus(id) {
  var e = PROV_ELS[id];
  if (!e) return;
  var area = e.status;
  area.textContent = '';
  var r = PROV_STATUS[id];
  if (!r) {
    area.appendChild(el('p', 'help', T('noRecent')));
    return;
  }
  var c = el('div', 'rescard' + (r.ok === false ? ' fail' : ''));
  var head = el('div', 'line');
  head.appendChild(el('span', 'resx', r.ok ? '\u2705' : '\u274c'));
  head.appendChild(el('strong', 'mono', id));
  head.appendChild(el('span', 'badge b-muted', T(r.kind === 'refresh' ? 'refreshB' : 'testB')));
  if (typeof r.latencyMs === 'number') head.appendChild(el('span', 'lbl', secs(r.latencyMs)));
  c.appendChild(head);
  if (r.ok === false) {
    var lt = labelText(r);
    if (lt) c.appendChild(el('div', 'lbl', lt));
    if (r.text) c.appendChild(el('div', 'pre mono', String(r.text).slice(0, 300)));
  } else if (r.kind === 'refresh') {
    c.appendChild(el('div', 'lbl', T('modelsSynced') + ': ' + (r.count === null || r.count === undefined ? '?' : r.count)));
    if (typeof r.fetched === 'number') {
      c.appendChild(el('div', 'lbl', T('syncKept') + ': ' + (r.kept || 0) + '/' + r.fetched + ' · ' + T('syncDropped') + ': ' + (r.dropped || 0)));
    }
    c.appendChild(el('div', 'lbl', T('addedLabel') + ': +' + (r.added || 0) + ' · ' + T('removedLabel') + ': -' + (r.removed || 0)));
    c.appendChild(el('div', 'lbl', T('lastSync') + ': ' + ago(r.at)));
  } else {
    c.appendChild(el('div', 'lbl', T('modelsAvailable') + ': ' + (r.count === null || r.count === undefined ? '?' : r.count)));
    c.appendChild(el('div', 'lbl', T('checked') + ': ' + ago(r.at)));
  }
  area.appendChild(c);
}

function finishProvBusy(id, which) {
  var e = PROV_ELS[id];
  if (e && e[which]) idle(e[which]);
  PROV_BUSY[id] = false;
  setProvButtons(id, false);
}

async function testProvider(id) {
  if (PROV_BUSY[id]) return;
  var e = PROV_ELS[id];
  if (!e) return;
  PROV_BUSY[id] = true;
  setProvButtons(id, true);
  busy(e.test);
  var started = Date.now();
  var r = await api('POST', '/admin/api/test', { provider: id }, { quiet: true });
  var d = r.data || { ok: false, status: r.status || null, text: r.error || '' };
  var out;
  if (d.ok) {
    out = {
      ok: true, kind: 'test', count: (typeof d.count === 'number') ? d.count : null,
      latencyMs: Date.now() - started, at: Date.now()
    };
  } else {
    out = {
      ok: false, kind: 'test', status: (typeof d.status === 'number') ? d.status : (r.status || null),
      label: d.label || null, text: d.snippet || d.text || d.error || r.error || '',
      latencyMs: Date.now() - started, at: Date.now()
    };
  }
  PROV_STATUS[id] = out;
  saveProvStatus();
  finishProvBusy(id, 'test');
  renderProvStatus(id);
}

async function refreshProvider(id) {
  if (PROV_BUSY[id]) return;
  var e = PROV_ELS[id];
  if (!e) return;
  PROV_BUSY[id] = true;
  setProvButtons(id, true);
  busy(e.refresh, 'loading');
  var started = Date.now();
  var r = await api('POST', '/admin/api/providers/' + encodeURIComponent(id) + '/refresh', undefined, { quiet: true });
  var out;
  if (r.data && r.data.ok) {
    var count = (typeof r.data.kept === 'number') ? r.data.kept : null;
    if (count === null) {
      var mr = await api('GET', '/admin/api/models?provider=' + encodeURIComponent(id), undefined, { quiet: true });
      if (mr.data && mr.data.ok) count = (mr.data.models || []).length;
    }
    SYNC_INFO[id] = {
      fetched: (typeof r.data.fetched === 'number') ? r.data.fetched : null,
      kept: (typeof r.data.kept === 'number') ? r.data.kept : null,
      dropped: (typeof r.data.dropped === 'number') ? r.data.dropped : null,
      at: Date.now()
    };
    out = {
      ok: true, kind: 'refresh', count: count, added: r.data.added || 0, removed: r.data.removed || 0,
      fetched: SYNC_INFO[id].fetched, kept: SYNC_INFO[id].kept, dropped: SYNC_INFO[id].dropped,
      latencyMs: Date.now() - started, at: Date.now()
    };
  } else {
    var d = r.data || {};
    out = {
      ok: false, kind: 'refresh', status: (typeof d.status === 'number') ? d.status : (r.status || null),
      label: d.label || null, text: d.snippet || d.error || r.error || '',
      latencyMs: Date.now() - started, at: Date.now()
    };
  }
  PROV_STATUS[id] = out;
  saveProvStatus();
  finishProvBusy(id, 'refresh');
  renderProvStatus(id);
  renderSyncLine(id);
  TAGS_CACHE[id] = {};
}

async function deleteProvider(id) {
  var p = null;
  CFG.providers.forEach(function (x) { if (x.id === id) p = x; });
  if (p && p.builtin) return;
  if (!window.confirm(T('confirmDel') + ' [' + id + ']?')) return;
  var r = await api('DELETE', '/admin/api/providers/' + encodeURIComponent(id));
  if (r.data && r.data.ok) {
    toast('[' + id + '] ' + T('delDone'), 'okly');
    delete PROV_STATUS[id];
    saveProvStatus();
    Object.keys(RESULTS).forEach(function (k) { if (k.indexOf(id + '/') === 0) delete RESULTS[k]; });
    saveResults();
    var wasCurrent = (MODEL_STATE.provider === id || CUR_PROVIDER === id);
    if (wasCurrent) {
      MODEL_STATE.provider = '';
      MODEL_STATE.summary = null;
      CUR_MODELS = [];
      CUR_PROVIDER = '';
      APPLIED_KEY = '';
      saveModelState();
    }
    await refreshCfg();
    if (wasCurrent) applyModelStateToInputs();
    renderRows();
    renderSummary();
  }
}

function openProviderForm(id) {
  var p = null;
  CFG.providers.forEach(function (x) { if (x.id === id) p = x; });
  $('provFormTitle').textContent = p ? T('editProvider') : T('newProvider');
  $('pId').value = p ? p.id : '';
  $('pId').disabled = Boolean(p);
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
    await refreshCfg();
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
  var wanted = prev || CUR_PROVIDER || MODEL_STATE.provider;
  if (wanted && CFG.providers.some(function (p) { return p.id === wanted; })) sel.value = wanted;
  else if (CFG.providers[0]) sel.value = CFG.providers[0].id;
}

function applyModelStateToInputs() {
  $('mQ').value = MODEL_STATE.q || '';
  $('mStatus').value = MODEL_STATE.status || 'all';
  if ($('mCap')) $('mCap').value = MODEL_STATE.cap || 'all';
  $('mOnlyOk').checked = MODEL_STATE.onlyOk === true;
  $('mOnlyUntested').checked = MODEL_STATE.onlyUntested === true;
  var sel = $('mProvider');
  if (MODEL_STATE.provider && CFG.providers.some(function (p) { return p.id === MODEL_STATE.provider; })) {
    sel.value = MODEL_STATE.provider;
  } else if (sel.value) {
    MODEL_STATE.provider = sel.value;
    saveModelState();
  }
  CUR_PROVIDER = sel.value || '';
}

function badgeFor(m) {
  var r = resultFor(CUR_PROVIDER, m.id);
  var wrap = el('span', 'badge-wrap');
  if (r) {
    var stale = isStale(r);
    var b = el('span', 'badge ' + (r.ok ? 'b-ok' : 'b-ban') + (stale ? ' stale' : ''),
      r.ok ? '\u2705 ' + secs(r.latencyMs) : '\u274c ' + labelText(r));
    var age = el('span', 'age' + (stale ? ' stale' : ''),
      T('testedAgo') + ' ' + ago(r.testedAt) + (stale ? ' · ' + T('stale') : ''));
    wrap.appendChild(b);
    wrap.appendChild(age);
  } else {
    wrap.appendChild(el('span', 'badge ' + (STATUS_CLASS[m.status] || 'b-muted'), T(STATUS_KEY[m.status] || 'stOk')));
    wrap.appendChild(el('span', 'age', T('untested')));
  }
  return wrap;
}

function renderRows() {
  var tb = $('mTbody');
  tb.textContent = '';
  ROW_ELS = {};
  if (!CUR_PROVIDER) {
    showErr('mErr', T('needSearch'));
    updateTestAllLabel();
    refreshBusy();
    return;
  }
  shownModels().forEach(function (m) {
    var tr = el('tr');
    var tdModel = el('td', 'model-cell');
    tdModel.setAttribute('data-label', T('modelCol'));
    var idSpan = el('span', 'mono', m.id);
    tdModel.appendChild(idSpan);
    var tags = modelTags(m);
    if (tags.length) {
      var chips = el('div', 'chips');
      tags.forEach(function (tag) {
        chips.appendChild(el('span', 'chip', T(tagKey(tag))));
      });
      tdModel.appendChild(chips);
    }
    tr.appendChild(tdModel);

    var tdStatus = el('td');
    tdStatus.setAttribute('data-label', T('statusCol'));
    tdStatus.appendChild(badgeFor(m));
    tr.appendChild(tdStatus);

    var tdAct = el('td', 'actions-cell');
    tdAct.setAttribute('data-label', T('actions'));
    var act = el('div', 'actions');
    var bt = btn(T('testB'), function () { testModel(CUR_PROVIDER, m.id, bt); }, 'sm');
    var ab = btn(T('addCombo'), function () { openAddToCombo(CUR_PROVIDER, m.id); }, 'sm');
    act.appendChild(bt);
    act.appendChild(ab);
    tdAct.appendChild(act);
    tr.appendChild(tdAct);

    tb.appendChild(tr);
    ROW_ELS[m.id] = { status: tdStatus, test: bt, add: ab };
  });
  var n = shownModels().length;
  showErr('mErr', n ? '' : T('noModels'));
  updateTestAllLabel();
  refreshBusy();
}

function shownModels() {
  var st = $('mStatus').value;
  var cap = $('mCap') ? $('mCap').value : 'all';
  var out = CUR_MODELS.filter(function (m) { return st === 'all' || m.status === st; });
  if (cap !== 'all') {
    out = out.filter(function (m) { return modelTags(m).indexOf(cap) >= 0; });
  }
  if ($('mOnlyOk').checked) {
    out = out.filter(function (m) {
      var r = resultFor(CUR_PROVIDER, m.id);
      return r && r.ok === true;
    });
  }
  return out;
}

function modelsForRun() {
  var out = shownModels();
  if ($('mOnlyUntested').checked) {
    var prov = CUR_PROVIDER;
    out = out.filter(function (m) { return isStale(resultFor(prov, m.id)); });
  }
  return out;
}

function updateTestAllLabel() {
  if (runActive) {
    $('mTestAll').textContent = T('testing');
    return;
  }
  var n = modelsForRun().length;
  $('mTestAll').textContent = T('testAll') + ' (' + Math.min(n, TEST_ALL_CAP) + ')';
}

function refreshBusy() {
  $('mTestAll').disabled = runActive;
  $('mStop').classList.toggle('hidden', !runActive);
  $('mSearch').disabled = runActive;
  $('mStatus').disabled = runActive;
  if ($('mCap')) $('mCap').disabled = runActive;
  $('mProvider').disabled = runActive;
  $('mQ').disabled = runActive;
  $('mOnlyOk').disabled = runActive;
  $('mOnlyUntested').disabled = runActive;
  $('mClearProv').disabled = runActive || !CUR_PROVIDER;
  $('mClearAll').disabled = runActive;
  Object.keys(ROW_ELS).forEach(function (mid) {
    ROW_ELS[mid].test.disabled = runActive;
    ROW_ELS[mid].add.disabled = runActive;
  });
}

async function searchModels() {
  if (runActive) return;
  var id = $('mProvider').value;
  var q = $('mQ').value.trim();
  if (!id) { showErr('mErr', T('needSearch')); return; }
  CUR_PROVIDER = id;
  MODEL_STATE.provider = id;
  MODEL_STATE.q = q;
  saveModelState();
  APPLIED_KEY = id + '|' + q;
  var seq = ++searchSeq;
  busy($('mSearch'), 'loading');
  showErr('mErr', T('loading'));
  var r = await api('GET', '/admin/api/models?provider=' + encodeURIComponent(id) + (q ? '&q=' + encodeURIComponent(q) : ''), undefined, { quiet: true });
  if (seq !== searchSeq) return;
  idle($('mSearch'));
  if (!(r.data && r.data.ok)) {
    CUR_MODELS = [];
    APPLIED_KEY = '';
    renderRows();
    showErr('mErr', r.error || T('loadFail'));
    return;
  }
  CUR_MODELS = r.data.models || [];
  renderRows();
}

async function ensureModels() {
  if (!CFG) return;
  var id = $('mProvider').value || MODEL_STATE.provider || CUR_PROVIDER;
  if (!id) { renderRows(); renderSummary(); return; }
  if (!CUR_PROVIDER) CUR_PROVIDER = id;
  var key = id + '|' + $('mQ').value.trim();
  if (APPLIED_KEY !== key) {
    await searchModels();
  } else {
    renderRows();
    renderSummary();
  }
}

async function testModel(prov, mid, btnEl) {
  busy(btnEl);
  var r = await api('POST', '/admin/api/test', { provider: prov, model: mid }, { quiet: true });
  idle(btnEl);
  var data = r.data;
  if (!data || (data.ok !== true && data.ok !== false)) {
    data = { ok: false, status: r.status || null, label: null, text: r.error || '' };
  }
  setResult(prov, mid, data);
  showResult('mResult', data, prov + '/' + mid);
  repaintRow(mid);
  updateTestAllLabel();
}

function repaintRow(mid) {
  var cell = ROW_ELS[mid] && ROW_ELS[mid].status;
  if (!cell) return;
  cell.textContent = '';
  cell.appendChild(badgeFor({ id: mid, status: 'ok' }));
}

function renderSummary() {
  var box = $('mSummary');
  box.textContent = '';
  var s = MODEL_STATE.summary;
  if (!s) return;
  var c = el('div', 'rescard');
  var head = el('div', 'line');
  head.appendChild(el('strong', null, T('runDone')));
  if (s.provider) head.appendChild(el('span', 'lbl', T('summaryProvider') + ': ' + s.provider));
  if (s.at) head.appendChild(el('span', 'lbl', ago(s.at)));
  if (s.stopped) head.appendChild(el('span', 'badge b-cool', T('stoppedEarly')));
  c.appendChild(head);
  c.appendChild(el('div', 'lbl', T('stOk') + ': ' + (s.ok || 0) + ' · ' + T('failedC') + ': ' + (s.failed || 0)));
  var fastest = Array.isArray(s.fastest) ? s.fastest : [];
  if (fastest.length) {
    c.appendChild(el('h3', null, T('fastest')));
    fastest.forEach(function (x) {
      var line = el('div', 'line');
      line.appendChild(el('span', 'mono badge b-ok', '\u2705 ' + x.id + ' — ' + secs(x.latencyMs)));
      line.appendChild(btn(T('addCombo'), function () { openAddToCombo(s.provider || '', x.id); }, 'sm'));
      c.appendChild(line);
    });
  }
  box.appendChild(c);
}

function clearResults(all) {
  var prov = $('mProvider').value || CUR_PROVIDER;
  if (!all && !prov) return;
  var msg = all ? T('clearConfirmAll') : T('clearConfirmProv') + (prov ? ' [' + prov + ']' : '');
  if (!window.confirm(msg)) return;
  if (all) {
    RESULTS = {};
    MODEL_STATE.summary = null;
  } else {
    var prefix = prov + '/';
    Object.keys(RESULTS).forEach(function (k) { if (k.indexOf(prefix) === 0) delete RESULTS[k]; });
    if (MODEL_STATE.summary && MODEL_STATE.summary.provider === prov) MODEL_STATE.summary = null;
  }
  saveResults();
  saveModelState();
  renderRows();
  renderSummary();
  toast(T('clearedResults'), 'okly');
}

// ── تست همه (پیمایشی، هم‌زمانی ۳) ───────────────────────────────────────────
async function runTestAll() {
  if (runActive) return;
  var list = modelsForRun();
  if (!list.length) { toast(T('nothingToTest'), 'err'); return; }
  if (list.length > TEST_ALL_CAP) {
    toast(T('tooManyMsg'), 'err');
    list = list.slice(0, TEST_ALL_CAP);
  }
  var prov = CUR_PROVIDER;
  var total = list.length;
  var done = 0, okc = 0, failc = 0;
  runActive = true;
  runStopping = false;
  MODEL_STATE.summary = null;
  saveModelState();
  renderSummary();
  refreshBusy();
  $('mProgress').classList.remove('hidden');
  $('mBar').style.width = '0%';
  $('mCount').textContent = '0/' + total + ' — ' + T('stOk') + ': 0 · ' + T('failedC') + ': 0';
  $('mStop').disabled = false;
  $('mTestAll').textContent = T('testing');
  var idx = 0;
  var results = [];
  async function worker() {
    while (!runStopping) {
      var i = idx++;
      if (i >= total) break;
      var m = list[i];
      var r = await api('POST', '/admin/api/test', { provider: prov, model: m.id }, { quiet: true });
      if (r.status === 401) runStopping = true;
      var data = r.data;
      if (!data || (data.ok !== true && data.ok !== false)) {
        data = { ok: false, status: r.status || null, label: null, text: r.error || '' };
      }
      setResult(prov, m.id, data);
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
  var stopped = runStopping;
  runActive = false;
  runStopping = false;
  refreshBusy();
  $('mProgress').classList.add('hidden');
  var good = results.filter(function (x) { return x.data.ok; });
  good.sort(function (a, b) { return (a.data.latencyMs || 0) - (b.data.latencyMs || 0); });
  MODEL_STATE.summary = {
    provider: prov,
    ok: okc,
    failed: failc,
    at: Date.now(),
    stopped: stopped,
    fastest: good.slice(0, 5).map(function (x) { return { id: x.id, latencyMs: x.data.latencyMs }; })
  };
  saveModelState();
  renderRows();
  renderSummary();
}

// ── افکتِ «افزودن به combo» ─────────────────────────────────────────────────
function closeOverlay() {
  var o = $('ovl');
  o.className = '';
  o.textContent = '';
}

function openAddToCombo(prov, model) {
  if (!CFG) return;
  var tags = tagsForModel(prov, model);
  var suggestedKind = suggestKind(tags);
  var ov = $('ovl');
  ov.className = 'overlay';
  ov.textContent = '';
  var card = el('div', 'card pop');
  card.appendChild(el('h3', null, T('addComboTitle')));
  card.appendChild(el('div', 'mono lbl', prov + '/' + model));
  card.appendChild(el('p', 'help', T('addToQ')));
  var list = el('div', 'stack');
  var ordered = orderedCombos(CFG.combos || [], tags);
  ordered.forEach(function (x) {
    var c = x.combo;
    var fit = x.fit;
    var row = el('div', 'line');
    var b = btn(c.name + ' · ' + T(kindKey(c.kind || 'custom')) + ' (' + ((c.targets || []).length) + ')', function () {
      addToCombo(c, prov, model, b);
    }, 'sm' + (fit.mayNotFit ? ' fit-warn' : ''));
    row.appendChild(b);
    if (fit.mayNotFit) {
      row.appendChild(el('span', 'lbl may-not-fit', T('mayNotFit')));
    }
    list.appendChild(row);
  });
  if (!CFG.combos || !CFG.combos.length) list.appendChild(el('p', 'lbl', T('newComboHint')));
  card.appendChild(list);

  card.appendChild(el('h3', null, T('newComboOpt')));
  var line = el('div', 'line');
  var nameInput = el('input', 'mono grow');
  nameInput.maxLength = 40;
  nameInput.placeholder = T('comboNamePh');
  var createBtn = btn(T('createAndAdd') + ' (' + T(kindKey(suggestedKind)) + ')', function () {
    createComboWithTarget(nameInput.value.trim(), suggestedKind, prov, model, createBtn);
  }, 'primary');
  nameInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      createBtn.click();
    }
  });
  line.appendChild(nameInput);
  line.appendChild(createBtn);
  card.appendChild(line);

  var foot = el('div', 'line');
  foot.appendChild(btn(T('cancel'), closeOverlay, 'ghost'));
  card.appendChild(foot);
  ov.appendChild(card);
  nameInput.focus();
}

$('ovl').addEventListener('click', function (ev) {
  if (ev.target.id === 'ovl') closeOverlay();
});
$('ovl').addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') closeOverlay();
});

async function addToCombo(c, prov, model, btnEl) {
  var targets = (c.targets || []).map(function (t) {
    return { provider: t.provider, model: t.model, enabled: t.enabled !== false };
  });
  targets.push({ provider: prov, model: model, enabled: true });
  if (targets.length > TARGET_LIMIT) { toast(T('maxTargetsMsg'), 'err'); return; }
  busy(btnEl, 'loading');
  var r = await api('PUT', '/admin/api/combos/' + encodeURIComponent(c.name), {
    name: c.name, kind: c.kind || 'custom', strategy: c.strategy, timeoutMs: c.timeoutMs, retries: c.retries || 0, targets: targets
  });
  idle(btnEl);
  if (r.data && r.data.ok) {
    closeOverlay();
    await refreshCfg();
    toast(prov + '/' + model + ' → [' + c.name + '] ' + T('addedDone'), 'okly', {
      label: T('goToCombo'),
      fn: function () { showTab('combosTab'); }
    });
  }
}

async function createComboWithTarget(name, kind, prov, model, btnEl) {
  if (!name) { toast(T('nameRequired'), 'err'); return; }
  busy(btnEl, 'loading');
  var r = await api('POST', '/admin/api/combos', {
    name: name,
    kind: kind || 'custom',
    strategy: 'priority',
    timeoutMs: 20000,
    retries: 0,
    targets: [{ provider: prov, model: model, enabled: true }]
  });
  idle(btnEl);
  if (r.data && r.data.ok) {
    closeOverlay();
    await refreshCfg();
    toast(prov + '/' + model + ' → [' + name + '] ' + T('addedDone'), 'okly', {
      label: T('goToCombo'),
      fn: function () { showTab('combosTab'); }
    });
  }
}

// ── comboهای خودکار داخلی — کارت فقط‌خواندنی + ساخت نسخه‌ی دستی ─────────────
function renderAutoCombos() {
  var list = $('autoList');
  if (!list) return;
  list.textContent = '';
  if (!CFG) return;
  AUTO_COMBOS.forEach(function (name) {
    var manualExists = (CFG.combos || []).some(function (c) { return c.name === name; });
    var card = el('div', 'card combo-card');
    var head = el('div', 'combo-head');
    var title = el('div', 'line');
    title.appendChild(el('strong', 'mono', name));
    title.appendChild(el('span', 'badge b-ok', T('autoBadge')));
    title.appendChild(el('span', 'badge b-muted', T(kindKey(AUTO_KINDS[name] || 'custom'))));
    if (manualExists) title.appendChild(el('span', 'badge b-cool', T('manualCombos')));
    head.appendChild(title);
    card.appendChild(head);
    card.appendChild(el('p', 'help', T('autoReadonly')));
    var act = el('div', 'line');
    var b = btn(T('createManualCopy'), function () { createManualCopy(name, b); }, 'sm');
    act.appendChild(b);
    card.appendChild(act);
    list.appendChild(card);
  });
}

async function createManualCopy(name, btnEl) {
  if (!CFG) return;
  if ((CFG.combos || []).some(function (c) { return c.name === name; })) {
    toast(T('copyExists'), 'err');
    return;
  }
  busy(btnEl, 'loading');
  var r = await api('GET', '/admin/api/auto/' + encodeURIComponent(name), undefined, { quiet: true });
  if (!(r.data && r.data.ok)) {
    idle(btnEl);
    toast(r.error || T('copyEmpty'), 'err');
    return;
  }
  var targets = (r.data.targets || []).slice(0, 8);
  if (!targets.length) {
    idle(btnEl);
    toast(T('copyEmpty'), 'err');
    return;
  }
  var c = await api('POST', '/admin/api/combos', {
    name: name,
    kind: r.data.kind || AUTO_KINDS[name] || 'custom',
    strategy: 'priority',
    timeoutMs: 20000,
    retries: 0,
    targets: targets
  }, { quiet: true });
  idle(btnEl);
  if (c.data && c.data.ok) {
    toast('[' + name + '] ' + T('copyCreated'), 'okly');
    await refreshCfg();
  } else {
    toast(c.error || T('loginFail'), 'err');
  }
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
  var up = btn('\u2191', function () {
    if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
  }, 'sm');
  up.title = T('moveUp');
  up.setAttribute('aria-label', T('moveUp'));
  row.appendChild(up);
  var down = btn('\u2193', function () {
    if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
  }, 'sm');
  down.title = T('moveDown');
  down.setAttribute('aria-label', T('moveDown'));
  row.appendChild(down);
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
  if (!CFG || !CFG.combos || !CFG.combos.length) {
    var empty = el('div', 'empty');
    empty.appendChild(el('p', null, T('noCombos')));
    list.appendChild(empty);
    return;
  }
  CFG.combos.forEach(function (c) {
    var card = el('div', 'card combo-card');
    var head = el('div', 'line');
    head.appendChild(el('strong', 'mono', c.name));
    head.appendChild(el('span', 'badge b-muted', T(kindKey(c.kind || 'custom'))));
    head.appendChild(el('span', 'lbl', c.strategy + ' · ' + c.timeoutMs + 'ms · ' + (c.retries || 0) + 'r · ' + ((c.targets || []).length) + 't'));
    card.appendChild(head);

    var tools = el('div', 'line');
    var res = el('div', 'combo-res');
    var tb = btn(T('testCombo'), function () { testCombo(c.name, res, tb); }, 'sm');
    tools.appendChild(tb);
    tools.appendChild(btn(T('del'), function () { deleteCombo(c.name); }, 'sm danger'));
    card.appendChild(tools);
    card.appendChild(res);

    var opts = el('div', 'line');
    var kd = el('select');
    ['text', 'code', 'vision', 'reasoning', 'fast', 'custom'].forEach(function (k) {
      var ok = el('option', null, T(kindKey(k)));
      ok.value = k;
      kd.appendChild(ok);
    });
    kd.value = c.kind || 'custom';
    var st = el('select');
    ['priority', 'round-robin', 'fastest'].forEach(function (s2) {
      var o2 = el('option', null, s2);
      o2.value = s2;
      st.appendChild(o2);
    });
    st.value = c.strategy;
    var to = el('input');
    to.type = 'number'; to.min = '1000'; to.max = '60000'; to.value = c.timeoutMs;
    var re = el('input');
    re.type = 'number'; re.min = '0'; re.max = '3'; re.value = c.retries || 0;
    opts.appendChild(el('span', 'lbl', T('kindLabel'))); opts.appendChild(kd);
    opts.appendChild(el('span', 'lbl', T('strategy'))); opts.appendChild(st);
    opts.appendChild(el('span', 'lbl', T('timeoutMs'))); opts.appendChild(to);
    opts.appendChild(el('span', 'lbl', T('retries'))); opts.appendChild(re);
    card.appendChild(opts);

    var box = el('div', 'stack');
    (c.targets || []).forEach(function (t) { box.appendChild(tgtRow(t)); });
    card.appendChild(box);

    var foot = el('div', 'line');
    foot.appendChild(btn('+ ' + T('tgtAdd'), function () {
      if (box.children.length >= TARGET_LIMIT) { toast(T('maxLimitReached'), 'err'); return; }
      box.appendChild(tgtRow({}));
    }, 'sm'));
    var fillInput = el('input');
    fillInput.type = 'number'; fillInput.min = '1'; fillInput.max = '30'; fillInput.value = '8';
    fillInput.style.width = '55px';
    fillInput.title = T('fillCount');
    fillInput.setAttribute('aria-label', T('fillCount'));
    var fillBtn = btn(T('fillFromTested'), async function () {
      var existing = gatherTargets(box);
      var remaining = TARGET_LIMIT - existing.length;
      if (remaining <= 0) { toast(T('maxLimitReached'), 'err'); return; }
      var limit = Math.max(1, Math.min(30, Math.floor(Number(fillInput.value) || 8)));
      limit = Math.min(limit, remaining);
      var providers = [];
      Object.keys(RESULTS).forEach(function (k) {
        var sl = k.indexOf('/');
        if (sl > 0) {
          var p = k.slice(0, sl);
          if (providers.indexOf(p) < 0) providers.push(p);
        }
      });
      await loadTagsForProviders(providers);
      var tagsByKey = {};
      Object.keys(RESULTS).forEach(function (k) {
        var sl = k.indexOf('/');
        if (sl > 0) {
          var p = k.slice(0, sl);
          var m = k.slice(sl + 1);
          var cache = TAGS_CACHE[p];
          tagsByKey[k] = (cache && cache[k]) ? cache[k] : inferTags(m);
        }
      });
      var picks = autoFillCandidates(RESULTS, kd.value, limit, existing, tagsByKey);
      if (!picks.length) { toast(T('fillNone'), 'err'); return; }
      picks.forEach(function (p) {
        box.appendChild(tgtRow({ provider: p.provider, model: p.model, enabled: true }));
      });
      toast(T('addedDone') + ' ' + picks.length, 'okly');
    }, 'sm');
    foot.appendChild(fillInput);
    foot.appendChild(fillBtn);

    var sb = btn(T('save'), async function () {
      var body = {
        name: c.name,
        kind: kd.value,
        strategy: st.value,
        timeoutMs: Number(to.value),
        retries: Number(re.value),
        targets: gatherTargets(box)
      };
      if (body.targets.length > TARGET_LIMIT) { toast(T('maxTargetsMsg'), 'err'); return; }
      if (body.targets.length < 1) { toast(T('needTarget'), 'err'); return; }
      busy(sb, 'saving');
      var r = await api('PUT', '/admin/api/combos/' + encodeURIComponent(c.name), body);
      idle(sb);
      if (r.data && r.data.ok) {
        toast('[' + c.name + '] ' + T('saved'), 'okly');
        await refreshCfg();
      }
    }, 'primary');
    foot.appendChild(sb);
    card.appendChild(foot);
    list.appendChild(card);
  });
}

async function testCombo(name, resEl, btnEl) {
  busy(btnEl);
  var r = await api('POST', '/admin/api/test', { combo: name }, { quiet: true });
  idle(btnEl);
  var data = r.data;
  if (!data || (data.ok !== true && data.ok !== false)) {
    data = { ok: false, status: r.status || null, latencyMs: null, label: null, text: r.error || '' };
  }
  showResultEl(resEl, data, T('comboTested') + ' [' + name + ']');
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
    await refreshCfg();
  }
}

function openComboFormBlank() {
  $('comboFormTitle').textContent = T('newCombo');
  $('cName').value = '';
  if ($('cKind')) $('cKind').value = 'custom';
  $('cStrategy').value = 'priority';
  $('cTimeout').value = '20000';
  $('cRetries').value = '0';
  var box = $('tgtBox');
  box.textContent = '';
  box.appendChild(tgtRow({}));
  showErr('comboErr', '');
  $('comboForm').classList.remove('hidden');
  $('cName').focus();
}

async function saveComboForm() {
  var name = $('cName').value.trim();
  var body = {
    name: name,
    kind: $('cKind') ? $('cKind').value : 'custom',
    strategy: $('cStrategy').value,
    timeoutMs: Number($('cTimeout').value),
    retries: Number($('cRetries').value),
    targets: gatherTargets($('tgtBox'))
  };
  if (!name) { showErr('comboErr', T('nameRequired')); return; }
  if (body.targets.length > TARGET_LIMIT) { showErr('comboErr', T('maxTargetsMsg')); return; }
  if (body.targets.length < 1) { showErr('comboErr', T('needTarget')); return; }
  busy($('comboSave'), 'saving');
  var r = await api('POST', '/admin/api/combos', body, { quiet: true });
  idle($('comboSave'));
  if (r.data && r.data.ok) {
    $('comboForm').classList.add('hidden');
    toast('[' + name + '] ' + T('saved'), 'okly');
    await refreshCfg();
  } else {
    showErr('comboErr', r.error || T('loginFail'));
  }
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

var tabButtons = document.querySelectorAll('[data-tab]');
for (var ti = 0; ti < tabButtons.length; ti++) {
  tabButtons[ti].addEventListener('click', function () { showTab(this.getAttribute('data-tab')); });
}
var themeButtons = document.querySelectorAll('[data-theme-set]');
for (var thi = 0; thi < themeButtons.length; thi++) {
  themeButtons[thi].addEventListener('click', function () { setTheme(this.getAttribute('data-theme-set')); });
}
$('langBtn').addEventListener('click', function () {
  lang = (lang === 'fa') ? 'en' : 'fa';
  applyLang();
  if (activeTab === 'modelsTab') updateTestAllLabel();
});

$('mSearch').addEventListener('click', searchModels);
$('mQ').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') searchModels(); });
$('mQ').addEventListener('input', function () {
  MODEL_STATE.q = this.value.trim();
  saveModelState();
});
$('mProvider').addEventListener('change', function () {
  CUR_PROVIDER = this.value;
  MODEL_STATE.provider = this.value;
  saveModelState();
  searchModels();
});
$('mStatus').addEventListener('change', function () {
  MODEL_STATE.status = this.value;
  saveModelState();
  renderRows();
});
if ($('mCap')) {
  $('mCap').addEventListener('change', function () {
    MODEL_STATE.cap = this.value;
    saveModelState();
    renderRows();
  });
}
$('mOnlyOk').addEventListener('change', function () {
  MODEL_STATE.onlyOk = this.checked;
  saveModelState();
  renderRows();
});
$('mOnlyUntested').addEventListener('change', function () {
  MODEL_STATE.onlyUntested = this.checked;
  saveModelState();
  updateTestAllLabel();
});
$('mTestAll').addEventListener('click', runTestAll);
$('mStop').addEventListener('click', function () { runStopping = true; $('mStop').disabled = true; });
$('mClearProv').addEventListener('click', function () { clearResults(false); });
$('mClearAll').addEventListener('click', function () { clearResults(true); });

var templateButtons = document.querySelectorAll('[data-template]');
for (var tpi = 0; tpi < templateButtons.length; tpi++) {
  templateButtons[tpi].addEventListener('click', function () { createTemplateCombo(this.getAttribute('data-template')); });
}

applyTheme();
applyLang();
boot();
</script>
</body>
</html>`;
