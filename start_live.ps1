# start_live.ps1 — Launcher único de DexterAI Extended live
# Arranca: OpenBB Platform API (Python) + Node Express + WebSocket + abre browser
#
# Uso: npm run live   o   powershell -ExecutionPolicy Bypass -File ./start_live.ps1

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  DexterAI Extended — Live Mode" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan

# ─── 1. Verificar venv OpenBB ───────────────────────────────────────────────
$workerDir = Join-Path $projectRoot "openbb_worker"
$venvDir   = Join-Path $workerDir ".venv"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $venvDir)) {
    Write-Host ""
    Write-Host "[setup] Creando venv Python en openbb_worker/.venv ..." -ForegroundColor Yellow
    python -m venv $venvDir
    if (-not (Test-Path $pythonExe)) {
        Write-Host "ERROR: no pude crear el venv. ¿Tienes Python 3.10+ instalado?" -ForegroundColor Red
        exit 1
    }
}

# ─── 2. Instalar dependencias OpenBB si falta ──────────────────────────────
$reqFile = Join-Path $workerDir "requirements.txt"
$flagFile = Join-Path $venvDir ".installed_flag"

if (-not (Test-Path $flagFile) -or ((Get-Item $reqFile).LastWriteTime -gt (Get-Item $flagFile).LastWriteTime)) {
    Write-Host "[setup] Instalando OpenBB (puede tomar 3-5 minutos la primera vez)..." -ForegroundColor Yellow
    & $pythonExe -m pip install --upgrade pip
    & $pythonExe -m pip install -r $reqFile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: pip install falló" -ForegroundColor Red
        exit 1
    }
    New-Item -ItemType File -Path $flagFile -Force | Out-Null
}

# ─── 3. Verificar node_modules ──────────────────────────────────────────────
if (-not (Test-Path (Join-Path $projectRoot "node_modules\ws"))) {
    Write-Host "[setup] Instalando deps de Node..." -ForegroundColor Yellow
    npm install
}

# ─── 4. Arrancar OpenBB worker en background ───────────────────────────────
Write-Host ""
Write-Host "[1/2] Arrancando OpenBB Platform API en :6900 ..." -ForegroundColor Green
$openbbStart = Join-Path $workerDir "start.py"
$openbbProcess = Start-Process -FilePath $pythonExe -ArgumentList $openbbStart -PassThru -WorkingDirectory $workerDir -WindowStyle Minimized

# Esperar a que /api/v1 responda (hasta 60s)
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:6900/api/v1/equity/search?query=AAPL&provider=yfinance" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}
if ($ready) {
    Write-Host "      OpenBB OK en http://127.0.0.1:6900" -ForegroundColor Green
} else {
    Write-Host "      OpenBB aún cargando (revisa openbb_worker/openbb.log)" -ForegroundColor Yellow
    Write-Host "      El servidor Node sigue arrancando — fallback a yfinance directo" -ForegroundColor Yellow
}

# ─── 5. Abrir browser después de un breve delay ────────────────────────────
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:3005"
} | Out-Null

# ─── 6. Trap para matar OpenBB al salir ─────────────────────────────────────
$cleanup = {
    Write-Host "`n[shutdown] Cerrando OpenBB worker..." -ForegroundColor Yellow
    try {
        if ($openbbProcess -and -not $openbbProcess.HasExited) {
            Stop-Process -Id $openbbProcess.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
Register-EngineEvent PowerShell.Exiting -Action $cleanup | Out-Null

# ─── 7. Arrancar Node server en foreground ──────────────────────────────────
Write-Host ""
Write-Host "[2/2] Arrancando Node server en :3005 ..." -ForegroundColor Green
Write-Host "      Browser se abrirá en http://localhost:3005" -ForegroundColor Green
Write-Host "      Ctrl+C para detener todo`n" -ForegroundColor Green

try {
    node server.js
} finally {
    & $cleanup
}
