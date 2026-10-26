# Smoke test for the OpenAI-compatible /v1 front door of this Worker.
# Env: BASE_URL    (e.g. https://my-agent.your-workspace.workers.dev)
#      ROUTER_KEY  (the value of the ROUTER_KEY secret)
# Usage: $env:BASE_URL = "..."; $env:ROUTER_KEY = "..."; .\scripts\smoke-v1.ps1
# Needs curl.exe with --ssl-no-revoke (Windows corporate TLS revocation quirk).
# Note: ROUTER_KEY itself must not contain spaces (it goes into a header arg).

$ErrorActionPreference = "Stop"

$base = $env:BASE_URL
$key = $env:ROUTER_KEY
if (-not $base -or -not $key) {
  Write-Host "FAIL: BASE_URL and ROUTER_KEY must be set in the environment."
  exit 1
}
if ($key -match "\s") {
  Write-Host "FAIL: ROUTER_KEY contains spaces; curl header arg would split."
  exit 1
}
$base = $base.TrimEnd("/")

$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("smoke-v1-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

function Write-JsonFile([string]$path, $obj) {
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-V1Post([string]$jsonFile, [string]$outFile, [string]$url, [switch]$stream) {
  if ($stream) {
    & curl.exe --ssl-no-revoke -s -N -H "Authorization: Bearer $key" -H "content-type: application/json" --data-binary "@$jsonFile" -o $outFile $url
  } else {
    & curl.exe --ssl-no-revoke -s -H "Authorization: Bearer $key" -H "content-type: application/json" --data-binary "@$jsonFile" -o $outFile $url
  }
  return $LASTEXITCODE
}

function Invoke-V1Get([string]$outFile, [string]$url) {
  & curl.exe --ssl-no-revoke -s -H "Authorization: Bearer $key" -o $outFile $url
  return $LASTEXITCODE
}

function Read-Body([string]$file) {
  return [IO.File]::ReadAllText($file)
}

# 1) /v1/models -------------------------------------------------------------

Write-Host "== /v1/models =="
$modelsFile = Join-Path $tmpDir "models.json"
$exitModels = Invoke-V1Get $modelsFile ($base + "/v1/models")
$modelsOk = $false
$comboNames = @()
$body = Read-Body $modelsFile
if ($exitModels -eq 0) {
  try {
    $mj = $body | ConvertFrom-Json
    if ($mj.object -eq "list" -and $mj.data -and $mj.data.Count) {
      $combos = @($mj.data | Where-Object { $_.id -like "combo/*" -and $_.owned_by -eq "router" })
      if ($combos.Count -gt 0) {
        $comboNames = @($combos | ForEach-Object { $_.id.Substring("combo/".Length) })
        $modelsOk = $true
        Write-Host "models: PASS ($($combos.Count) combo(s), $($mj.data.Count) entries total)"
        Write-Host "   combos: $(($comboNames | Select-Object -First 12) -join ', ')"
      }
    }
  } catch { }
}
if (-not $modelsOk) {
  Write-Host "models: FAIL (curl exit $exitModels)`n   body: $($body.Substring(0, [Math]::Min(300, $body.Length)))"
  exit 1
}

# 2) per combo: chat, streaming chat, tool calling -------------------------------

$results = @()
$i = 0
$weatherTool = @{
  type = "function"
  function = @{
    name = "get_weather"
    description = "Get current weather for a city"
    parameters = @{ type = "object"; properties = @{ city = @{ type = "string" } }; required = @("city") }
  }
}

foreach ($name in $comboNames) {
  $i++
  $id = "combo/$name"
  Write-Host ""
  Write-Host "== [$i/$($comboNames.Count)] $id =="

  # 2a. normal chat
  $chatFile = Join-Path $tmpDir "chat-$i.json"
  $respFile = Join-Path $tmpDir "chat-$i.resp.json"
  Write-JsonFile $chatFile @{
    model = $id
    messages = @(@{ role = "user"; content = "Reply with exactly: OK" })
    max_tokens = 20
  }
  $e1 = Invoke-V1Post $chatFile $respFile ($base + "/v1/chat/completions")
  $chatOk = $false
  $chatNote = ""
  try {
    $cj = (Read-Body $respFile) | ConvertFrom-Json
    $chatNote = [string]$cj.choices[0].message.content
    if ($chatNote) { $chatOk = $true }
    elseif ($cj.error) { $chatNote = "api error: $($cj.error.message)".Substring(0, [Math]::Min(160, ("api error: $($cj.error.message)".Length))) }
  } catch {
    $chatNote = "unparseable response"
  }
  if ($chatOk) { Write-Host "chat: PASS ('$chatNote')" } else { Write-Host "chat: FAIL (exit ${e1}) - $chatNote" }

  # 2b. streaming chat
  $streamFile = Join-Path $tmpDir "stream-$i.json"
  $streamResp = Join-Path $tmpDir "stream-$i.resp.txt"
  Write-JsonFile $streamFile @{
    model = $id
    messages = @(@{ role = "user"; content = "Say hello" })
    max_tokens = 20
    stream = $true
  }
  $e2 = Invoke-V1Post $streamFile $streamResp ($base + "/v1/chat/completions") -stream
  $sText = Read-Body $streamResp
  $streamOk = ($sText.Contains("data: ") -and $sText.Contains("[DONE]"))
  if ($streamOk) {
    Write-Host "stream: PASS (chunks + [DONE], $($sText.Length) bytes)"
  } else {
    Write-Host "stream: FAIL (exit ${e2}, not SSE with [DONE])"
  }

  # 2c. tool calling (get_weather) - report PASS/FAIL/INCONCLUSIVE per combo,
  # because not every free model knows how to emit tool calls.
  $toolFile = Join-Path $tmpDir "tool-$i.json"
  $toolResp = Join-Path $tmpDir "tool-$i.resp.json"
  Write-JsonFile $toolFile @{
    model = $id
    messages = @(@{ role = "user"; content = "What is the weather in Tehran right now? Use the get_weather tool." })
    tools = @($weatherTool)
    tool_choice = "auto"
    max_tokens = 80
  }
  $e3 = Invoke-V1Post $toolFile $toolResp ($base + "/v1/chat/completions")
  $toolBody = Read-Body $toolResp
  $toolVerdict = "INCONCLUSIVE"
  try {
    $tj = $toolBody | ConvertFrom-Json
    $tc = $tj.choices[0].message.tool_calls
    if ($tc -and @($tc).Count -gt 0) {
      $toolVerdict = "PASS"
    } elseif ($tj.error) {
      $toolVerdict = "FAIL"
    } elseif (-not $tj.choices) {
      $toolVerdict = "INCONCLUSIVE"
    }
  } catch {
    $toolVerdict = "FAIL"
  }
  Write-Host "tool calling: $toolVerdict"

  $results += [PSCustomObject]@{ Combo = $id; Chat = $chatOk; Stream = $streamOk; Tool = $toolVerdict }
}

# 3) summary -----------------------------------------------------------------

Write-Host ""
Write-Host "== SUMMARY =="
$results | Format-Table -AutoSize

foreach ($r in $results) {
  $toolLabel = if ($r.Tool -eq "PASS") { "tool calling: PASS" } elseif ($r.Tool -eq "FAIL") { "tool calling: FAIL" } else { "tool calling: INCONCLUSIVE" }
}
$bad = @($results | Where-Object { -not $_.Chat -or -not $_.Stream })
if ($bad.Count -eq 0) {
  Write-Host "chat + stream smoke: PASS for all $($results.Count) combo(s)."
  exit 0
}
Write-Host "chat + stream smoke: FAIL for: $(($bad | ForEach-Object { $_.Combo }) -join ', ')"
exit 1
