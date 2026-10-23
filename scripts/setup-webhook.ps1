<#
    setup-webhook.ps1 — Windows helper.

    Registers (or, with -Info, inspects) the Telegram webhook by calling the
    Worker's POST /setup route, which itself calls api.telegram.org. This is
    needed because Telegram is blocked on the local network, so api.telegram.org
    cannot be reached directly.

    Usage:
      .\scripts\setup-webhook.ps1                       # register webhook
      .\scripts\setup-webhook.ps1 -Info                 # show webhook status
      .\scripts\setup-webhook.ps1 -Url https://...      # other Worker URL

    Reads TG_SECRET from the local .dev.vars (git-ignored). Never prints the
    secret. Needs curl.exe (bundled with Windows 10+); --ssl-no-revoke works
    around blocked certificate-revocation checks on filtered networks.
#>

param(
    [string]$Url = "https://my-agent.nova-02aa82bffef8.workers.dev",
    [switch]$Info
)

$ErrorActionPreference = "Stop"

$devVarsPath = Join-Path $PSScriptRoot "..\.dev.vars"
if (-not (Test-Path -LiteralPath $devVarsPath)) {
    Write-Error "Could not find .dev.vars (copy .dev.vars.example to .dev.vars first)."
    exit 1
}

$secret = $null
foreach ($line in Get-Content -LiteralPath $devVarsPath) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 0) { continue }
    $key = $t.Substring(0, $eq).Trim()
    if ($key -eq "TG_SECRET") {
        $value = $t.Substring($eq + 1).Trim()
        if ($value) { $secret = $value }
    }
}
if (-not $secret) {
    Write-Error "TG_SECRET not found (or empty) in .dev.vars."
    exit 1
}

$target = if ($Info) { "$Url/setup?info=1" } else { "$Url/setup" }

$curlArgs = @(
    "--ssl-no-revoke",
    "--noproxy", "*",
    "-s",
    "-X", "POST",
    "-H", "X-Setup-Key: $secret",
    $target
)
curl.exe @curlArgs
Write-Output ""
