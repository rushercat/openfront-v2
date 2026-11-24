# openfront v2 von diesem Laptop aus hosten.
# Startet: Spielserver (Port 3000-3002), Router (Port 8080) und den Tunnel nach aussen:
# Tailscale Funnel (Standard) oder Cloudflare Tunnel, wenn hosting\cloudflared.yml existiert.
# Fenster schliessen oder Strg+C beendet alles wieder.
param([switch]$NoBuild)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$cfConfig = Join-Path $PSScriptRoot "cloudflared.yml"
$useCloudflare = Test-Path $cfConfig
$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { $cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }

if ($useCloudflare) {
  $publicHost = (Select-String -Path $cfConfig -Pattern "hostname:\s*(\S+)").Matches[0].Groups[1].Value
} else {
  $status = & $tailscale status --json | ConvertFrom-Json
  if ($status.BackendState -ne "Running") {
    Write-Host "Tailscale ist nicht verbunden. Tailscale-App oeffnen und anmelden, dann neu starten." -ForegroundColor Red
    Read-Host "Enter zum Schliessen"; exit 1
  }
  $publicHost = $status.Self.DNSName.TrimEnd(".")
}

foreach ($p in 3000, 3001, 3002, 8080) {
  if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Port $p ist belegt. Laeuft noch 'npm run dev' oder ein zweites Hosting-Fenster? Bitte erst beenden." -ForegroundColor Red
    Read-Host "Enter zum Schliessen"; exit 1
  }
}

if (-not $NoBuild) {
  Write-Host "Baue das Spiel (ca. 30 s)..." -ForegroundColor Cyan
  npm run build-prod
  if ($LASTEXITCODE -ne 0) { Read-Host "Build fehlgeschlagen. Enter zum Schliessen"; exit 1 }
}

# Lokaler Modus (wie npm run dev): ohne den OpenFront-Account-Dienst,
# Spieler werden nicht ueber Logins geprueft. Admin-Bot-API bleibt aus.
$env:GAME_ENV = "dev"
$env:DOMAIN = "localhost"
$env:TURNSTILE_SITE_KEY = "1x00000000000000000000AA"
$env:API_KEY = "local-only"
$env:GIT_COMMIT = (git rev-parse --short HEAD)
$env:NUM_WORKERS = "2"
Remove-Item Env:ADMIN_BOT_API_KEY -ErrorAction SilentlyContinue

$procs = @()
try {
  Write-Host "Starte Spielserver..." -ForegroundColor Cyan
  $procs += Start-Process node -ArgumentList "node_modules\tsx\dist\cli.mjs", "src\server\Server.ts" -NoNewWindow -PassThru
  $procs += Start-Process node -ArgumentList "hosting\router.mjs" -NoNewWindow -PassThru
  Start-Sleep 5
  Write-Host ""
  Write-Host "  Link fuer deine Freunde:  https://$publicHost" -ForegroundColor Green
  Write-Host "  Du selbst:                http://localhost:8080" -ForegroundColor Green
  Write-Host "  Beenden: dieses Fenster schliessen oder Strg+C" -ForegroundColor Green
  Write-Host ""
  if ($useCloudflare) {
    & $cloudflared tunnel --config $cfConfig run
  } else {
    & $tailscale funnel 8080
  }
}
finally {
  foreach ($p in $procs) { taskkill /PID $p.Id /T /F 2>$null | Out-Null }
}
