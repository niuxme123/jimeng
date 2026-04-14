# Jimeng AI Automation Tool Startup Script

$ErrorActionPreference = "Stop"

# Set console encoding to UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Get script directory
$ScriptPath = $MyInvocation.MyCommand.Path
if (-not $ScriptPath) {
    $ScriptPath = $PSCommandPath
}
$JmzrPath = Split-Path -Parent $ScriptPath
$ProjectRoot = Split-Path -Parent $JmzrPath
$NodePath = Join-Path $ProjectRoot "node-v24.14.1-win-x64"
$NodeModulesPath = Join-Path $ProjectRoot "node_modules"

Write-Host "========================================" -ForegroundColor Green
Write-Host "   Jimeng AI Automation Tool" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Show paths
Write-Host "[INFO] Project Root: $ProjectRoot" -ForegroundColor Cyan
Write-Host "[INFO] Node Path: $NodePath" -ForegroundColor Cyan
Write-Host "[INFO] App Path: $JmzrPath" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
$NodeExe = Join-Path $NodePath "node.exe"
if (-not (Test-Path $NodeExe)) {
    Write-Host "[ERROR] Node.js not found: $NodeExe" -ForegroundColor Red
    Write-Host "Please ensure node-v24.14.1-win-x64 directory exists" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Check Electron
$ElectronPath = Join-Path $NodeModulesPath "electron"
if (-not (Test-Path $ElectronPath)) {
    Write-Host "[ERROR] Electron module not found: $ElectronPath" -ForegroundColor Red
    Write-Host "Please run in WSL: npm install electron" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Check app files
$MainJs = Join-Path $JmzrPath "main.js"
if (-not (Test-Path $MainJs)) {
    Write-Host "[ERROR] App main file not found: $MainJs" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[CHECK] Node.js ... OK" -ForegroundColor Green
Write-Host "[CHECK] Electron ... OK" -ForegroundColor Green
Write-Host "[CHECK] App files ... OK" -ForegroundColor Green
Write-Host ""

# Set environment variables
$env:NODE_PATH = $NodeModulesPath
$env:ELECTRON_ENABLE_LOGGING = "1"
$env:PATH = "$NodePath;$env:PATH"
# Force UTF-8 for Node.js
$env:PYTHONIOENCODING = "utf-8"
$env:LANG = "en_US.UTF-8"

Write-Host "[START] Launching Electron app..." -ForegroundColor Yellow
Write-Host "[TIP] Press Ctrl+C to exit" -ForegroundColor Gray
Write-Host ""

# Change to app directory
Set-Location $JmzrPath

# Start Electron
$process = $null
try {
    # Find electron executable
    $ElectronExe = Join-Path $ElectronPath "dist\electron.exe"

    if (-not (Test-Path $ElectronExe)) {
        # Try path.txt to find electron
        $PathTxt = Join-Path $ElectronPath "path.txt"
        if (Test-Path $PathTxt) {
            $ElectronPathFromTxt = Get-Content $PathTxt -Raw
            $ElectronExe = $ElectronPathFromTxt.Trim()
        }
    }

    if (Test-Path $ElectronExe) {
        Write-Host "[INFO] Using Electron: $ElectronExe" -ForegroundColor Gray
        $process = Start-Process -FilePath $ElectronExe -ArgumentList ".", "--expose-gc" -PassThru
    } else {
        # Fallback: use node to run electron cli
        $ElectronCli = Join-Path $ElectronPath "cli.js"
        Write-Host "[INFO] Using Electron CLI: $ElectronCli" -ForegroundColor Gray
        $process = Start-Process -FilePath $NodeExe -ArgumentList $ElectronCli, ".", "--expose-gc" -PassThru
    }

    # Wait for process or Ctrl+C
    if ($process) {
        # Register Ctrl+C handler
        [Console]::TreatControlCAsInput = $false

        try {
            # Wait for process to exit
            $process.WaitForExit()
        }
        catch [System.Management.Automation.HaltCommandException] {
            # Ctrl+C was pressed
        }
    }
}
catch {
    Write-Host ""
    Write-Host "[ERROR] Failed to start: $_" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
}
finally {
    # Cleanup: kill electron process if still running
    if ($process -and !$process.HasExited) {
        Write-Host ""
        Write-Host "[EXIT] Stopping Electron..." -ForegroundColor Yellow
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "[DONE] Application closed" -ForegroundColor Green
