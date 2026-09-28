<#
.SYNOPSIS
    One-line automated installer for Warudo MCP.
    Usage:
        irm https://raw.githubusercontent.com/KhoaDayy/warudo-mcp/main/install.ps1 | iex
#>

$ErrorActionPreference = 'Stop'

function Write-Step ($msg) { Write-Host "`n[+] $msg" -ForegroundColor Cyan }
function Write-Success ($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn ($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err ($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }

Clear-Host
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host "               WARUDO MCP ONE-CLICK INSTALLER             " -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Magenta

# -------------------------------------------------------------------------
# Step 1: Check Node.js
# -------------------------------------------------------------------------
Write-Step "Checking Node.js environment..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCmd) {
    Write-Warn "Node.js was not found on your system."
    $response = Read-Host "Install Node.js LTS now with winget? [Y/n]"
    if ($response -eq '' -or $response -match '^[Yy]') {
        Write-Host "Installing Node.js LTS via winget..." -ForegroundColor Gray
        try {
            winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
            Write-Success "Node.js installation completed."
            Write-Warn "Please close this PowerShell window and run the installer again so the new PATH takes effect."
            return
        } catch {
            Write-Err "Winget installation failed. Please install Node.js manually from https://nodejs.org/"
            return
        }
    } else {
        Write-Err "Node.js (>=20) is required for Warudo MCP. Aborting installation."
        return
    }
} else {
    $nodeVer = & node -v
    Write-Success "Found Node.js $nodeVer ($($nodeCmd.Source))"
}

# -------------------------------------------------------------------------
# Step 2: Locate Warudo Plugins Folder & Deploy Pre-built .warudo Mod
# -------------------------------------------------------------------------
Write-Step "Locating Warudo installation and deploying compiled mod..."
$warudoPluginDir = Join-Path $env:USERPROFILE "AppData\LocalLow\HakuyaLabs\Warudo\Plugins"
$targetModPath = Join-Path $warudoPluginDir "Warudo-MCP.warudo"

if (-not (Test-Path $warudoPluginDir)) {
    Write-Host "Creating Warudo Plugins directory at $warudoPluginDir..." -ForegroundColor Gray
    New-Item -ItemType Directory -Path $warudoPluginDir -Force | Out-Null
}

$localModSource = Join-Path $PSScriptRoot "warudo-plugin\Warudo-MCP.warudo"

if (Test-Path $localModSource) {
    Write-Host "Copying local Warudo-MCP.warudo to Plugins folder..." -ForegroundColor Gray
    Copy-Item $localModSource -Destination $targetModPath -Force
    Write-Success "Deployed local mod to $targetModPath"
} else {
    Write-Host "Plugin installation note:" -ForegroundColor Gray
    Write-Host "  -> Subscribe to 'MCP Bridge' on Steam Workshop: https://steamcommunity.com/sharedfiles/filedetails/?id=3809919307" -ForegroundColor Cyan
}

# -------------------------------------------------------------------------
# Step 3: Clean up Legacy Playground Files (avoid type collisions)
# -------------------------------------------------------------------------
$legacyFiles = @(
    "McpBridgeAsset.cs",
    "OnMcpCommandNode.cs",
    "McpBridgeService.cs",
    "GameObjectPathResolver.cs",
    "MaterialKeywordOverrideStore.cs"
)

$commonPlaygroundPaths = @(
    (Join-Path $env:USERPROFILE "AppData\LocalLow\HakuyaLabs\Warudo\StreamingAssets\Playground"),
    "C:\Program Files (x86)\Steam\steamapps\common\Warudo\Warudo_Data\StreamingAssets\Playground",
    "D:\SteamLibrary\steamapps\common\Warudo\Warudo_Data\StreamingAssets\Playground",
    "E:\SteamLibrary\steamapps\common\Warudo\Warudo_Data\StreamingAssets\Playground"
)

foreach ($pPath in $commonPlaygroundPaths) {
    if (Test-Path $pPath) {
        foreach ($file in $legacyFiles) {
            $found = Get-ChildItem -Path $pPath -Filter $file -Recurse -ErrorAction SilentlyContinue
            foreach ($item in $found) {
                Write-Warn "Removing conflicting legacy file: $($item.FullName)"
                Remove-Item $item.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# -------------------------------------------------------------------------
# Step 4: Auto-Register MCP in Installed AI Clients
# -------------------------------------------------------------------------
Write-Step "Detecting and registering Warudo MCP in AI clients..."

$backupDir = Join-Path $env:USERPROFILE ".warudo-mcp\backups"
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

function Register-McpConfig ($appName, $configPath) {
    if (-not (Test-Path (Split-Path $configPath -Parent))) {
        return $false
    }

    try {
        $parentDir = Split-Path $configPath -Parent
        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        $config = @{ mcpServers = @{} }
        if (Test-Path $configPath) {
            $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
            $backupFile = Join-Path $backupDir "$appName`_$timestamp.json"
            Copy-Item $configPath -Destination $backupFile -Force
            try {
                $rawContent = Get-Content $configPath -Raw
                if ($rawContent.Trim() -ne '') {
                    $config = $rawContent | ConvertFrom-Json
                    if (-not $config.mcpServers) {
                        $config | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value ([PSCustomObject]@{})
                    }
                }
            } catch {
                $config = @{ mcpServers = @{} }
            }
        }

        $warudoConfig = [PSCustomObject]@{
            command = "npx"
            args = @("-y", "warudo-mcp-server")
        }

        if ($config.mcpServers -is [PSCustomObject]) {
            if ($config.mcpServers.PSObject.Properties['warudo']) {
                $config.mcpServers.warudo = $warudoConfig
            } else {
                $config.mcpServers | Add-Member -MemberType NoteProperty -Name "warudo" -Value $warudoConfig
            }
        } else {
            $config.mcpServers['warudo'] = $warudoConfig
        }

        $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
        Write-Success "$appName registered successfully!"
        return $true
    } catch {
        Write-Warn "Could not update $appName config ($configPath): $_"
        return $false
    }
}

$registeredCount = 0

# Claude Desktop
$claudeConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if (Register-McpConfig "Claude Desktop" $claudeConfig) { $registeredCount++ }

# Cursor
$cursorConfig = Join-Path $env:USERPROFILE ".cursor\mcp.json"
if (Register-McpConfig "Cursor" $cursorConfig) { $registeredCount++ }

# Cline (VS Code)
$clineConfig = Join-Path $env:APPDATA "Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json"
if (Register-McpConfig "Cline" $clineConfig) { $registeredCount++ }

# Roo Code (VS Code)
$rooConfig = Join-Path $env:APPDATA "Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json"
if (Register-McpConfig "Roo Code" $rooConfig) { $registeredCount++ }

# Windsurf
$windsurfConfig = Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json"
if (Register-McpConfig "Windsurf" $windsurfConfig) { $registeredCount++ }

# -------------------------------------------------------------------------
# Step 5: Summary & First Use Instructions
# -------------------------------------------------------------------------
Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "                INSTALLATION COMPLETE!                    " -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green

Write-Host @"
[ Summary ]
* Pre-built Mod Plugin : Installed to $targetModPath
* AI Apps Registered   : $registeredCount app(s) configured with npx -y warudo-mcp-server
* Config Backups       : Saved to $backupDir

[ Next Steps ]
1. Launch or Restart Warudo:
   - Go to Settings -> Plugin Settings -> Verify 'MCP Bridge' is active on port 5678.
2. Restart your AI Application (Claude Desktop, Cursor, Cline, or Windsurf).
3. Test your connection by prompting the AI:
   "Check Warudo status" -> It will invoke warudo_status and return your live scene!
"@ -ForegroundColor Cyan
