[CmdletBinding()]
param(
    [string]$ManagedPath = '',
    [string]$CompilerPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot 'warudo-plugin'

if ([string]::IsNullOrWhiteSpace($ManagedPath)) {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Steam/steamapps/common/Warudo/Warudo_Data/Managed'),
        (Join-Path $env:ProgramFiles 'Steam/steamapps/common/Warudo/Warudo_Data/Managed')
    )
    $ManagedPath = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'Warudo.Core.dll') } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($ManagedPath) -or -not (Test-Path -LiteralPath (Join-Path $ManagedPath 'Warudo.Core.dll'))) {
    throw 'Warudo managed assemblies not found. Pass -ManagedPath with the Warudo_Data/Managed directory.'
}
$ManagedPath = (Resolve-Path -LiteralPath $ManagedPath).Path

if ([string]::IsNullOrWhiteSpace($CompilerPath)) {
    $unityEditors = Join-Path $env:ProgramFiles 'Unity/Hub/Editor'
    if (Test-Path -LiteralPath $unityEditors) {
        $CompilerPath = Get-ChildItem -LiteralPath $unityEditors -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'Editor/Data/MonoBleedingEdge/lib/mono/msbuild/Current/bin/Roslyn/csc.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }
}
if ([string]::IsNullOrWhiteSpace($CompilerPath) -or -not (Test-Path -LiteralPath $CompilerPath)) {
    throw 'C# compiler not found. Pass -CompilerPath with a Roslyn csc.exe (C# 9 or newer).'
}
$CompilerPath = (Resolve-Path -LiteralPath $CompilerPath).Path

$referenceNames = @(
    'mscorlib.dll', 'System.dll', 'System.Core.dll', 'netstandard.dll',
    'Newtonsoft.Json.dll', 'UniTask.dll', 'UnityEngine.dll',
    'UnityEngine.CoreModule.dll', 'Warudo.Core.dll', 'Warudo.Plugins.Core.dll',
    'websocket-sharp.dll'
)
$references = foreach ($name in $referenceNames) {
    $path = Join-Path $ManagedPath $name
    if (-not (Test-Path -LiteralPath $path)) { throw "Required assembly is missing: $name" }
    '-r:"' + $path + '"'
}
$sources = Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs' -Recurse -File
if ($sources.Count -eq 0) { throw 'No bridge source files were found.' }

# Source contract: the distribution contains one scene-independent plugin and
# only the generic bridge implementation. It must not silently regain the old
# scene asset, Blueprint node, or model-specific features.
$requiredFiles = @(
    'McpBridgePlugin.cs',
    'McpBridgeService.cs',
    'GameObjectPathResolver.cs',
    'MaterialKeywordOverrideStore.cs'
)
foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative))) {
        throw "Required bridge source file is missing: $relative"
    }
}
$forbiddenFiles = @(
    'EkuHashFaceTrackingNode.cs',
    'EkuHashAnimatorParameterBridgeNode.cs',
    'Nodes/VmcHandTrackingNode.cs',
    'Nodes/GlowOutfitNode.cs',
    'McpBridgeAsset.cs',
    'Nodes/OnMcpCommandNode.cs'
)
foreach ($relative in $forbiddenFiles) {
    if (Test-Path -LiteralPath (Join-Path $sourceRoot $relative)) {
        throw "Forbidden obsolete or model-specific source file is present: $relative"
    }
}
$forbiddenTokens = @('EkuHash', 'VmcHandTracking', 'GlowOutfit', 'glow_outfit', 'switch_outfit')
$forbiddenRuntimeTokens = @('System.Reflection', 'GetCustomAttribute', 'System.IO')
foreach ($source in $sources) {
    $text = Get-Content -LiteralPath $source.FullName -Raw
    foreach ($token in $forbiddenTokens) {
        if ($text.IndexOf($token, [System.StringComparison]::Ordinal) -ge 0) {
            throw "Forbidden model-specific token '$token' found in $($source.FullName)"
        }
    }
    foreach ($token in $forbiddenRuntimeTokens) {
        if ($text.IndexOf($token, [System.StringComparison]::Ordinal) -ge 0) {
            throw "Plugin-incompatible runtime token '$token' found in $($source.FullName)"
        }
    }
}

$pluginSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'McpBridgePlugin.cs') -Raw
if ($pluginSource -notmatch '\[PluginType\s*\(') {
    throw 'Bridge plugin contract is missing the PluginType attribute.'
}
if ($pluginSource -notmatch 'class\s+McpBridgePlugin\s*:\s*Plugin\b') {
    throw 'Bridge plugin contract must inherit Warudo Plugin.'
}
if ($pluginSource -match '\b(?:AssetTypes|NodeTypes)\b') {
    throw 'Bridge plugin must not register scene asset or Blueprint node types.'
}

# Port changes are detected from the port captured for the successful bind. Keep
# the state update paired with server start/stop so OnUpdate cannot restart every frame.
if ($pluginSource -notmatch 'server\s*=\s*pendingServer;\s*activePort\s*=\s*requestedPort;') {
    throw 'Bridge lifecycle contract is missing the active port assignment after startup.'
}
if ($pluginSource -notmatch 'server\s*=\s*null;\s*activePort\s*=\s*-1;') {
    throw 'Bridge lifecycle contract is missing the active port reset during shutdown.'
}

# A response can become ready after the requesting client times out during scene load.
# Keep the only raw Send call inside the transport guard so a closed socket cannot
# escape HandleAction or trigger a second send from its error path.
$serviceSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'McpBridgeService.cs') -Raw
$rawSendCalls = [regex]::Matches($serviceSource, '(?m)\bSend\s*\(')
if ($rawSendCalls.Count -ne 1) {
    throw "Bridge response contract expected exactly one guarded raw Send call; found $($rawSendCalls.Count)."
}
if ($serviceSource -notmatch '(?s)private\s+void\s+SendResponse\s*\([^)]*\)\s*\{\s*try\s*\{\s*Send\s*\(response\);\s*\}\s*catch\s*\(Exception') {
    throw 'Bridge response contract is missing the guarded transport send.'
}
if ([regex]::Matches($serviceSource, '\bSendResponse\s*\(').Count -ne 3) {
    throw 'Bridge response contract requires RespondOk and RespondError to use SendResponse.'
}
if ($serviceSource -notmatch '(?s)catch\s*\(Exception\s+e\).*?try\s*\{\s*RespondError\s*\(action,\s*id,\s*e\.Message\);\s*\}\s*catch\s*\(Exception\s+responseError\)') {
    throw 'Bridge response contract is missing the non-throwing error-response fallback.'
}

# Compile into an isolated temporary directory. This never installs the plugin,
# writes into Warudo, or launches Warudo.
$checkRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('warudo-mcp-check-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $checkRoot | Out-Null
$outputPath = Join-Path $checkRoot 'WarudoMcpBridge.Check.dll'
$responsePath = Join-Path $checkRoot 'compile.rsp'
$contractSource = Join-Path $checkRoot 'BridgeContract.cs'
$contractExe = Join-Path $checkRoot 'BridgeContract.exe'
try {
    $arguments = @('-nologo', '-target:library', '-langversion:9', '-nostdlib+', ('-out:"' + $outputPath + '"'))
    $arguments += $references
    $arguments += $sources | ForEach-Object { '"' + $_.FullName + '"' }
    $arguments | Set-Content -LiteralPath $responsePath -Encoding UTF8
    $monoPath = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $CompilerPath) '../../../../../../bin/mono.exe'))
    if (Test-Path -LiteralPath $monoPath) {
        & $monoPath $CompilerPath ('@' + $responsePath)
    } else {
        & $CompilerPath ('@' + $responsePath)
    }
    if ($LASTEXITCODE -ne 0) { throw "Bridge compilation failed (exit $LASTEXITCODE)." }
    Write-Output "Bridge compiled successfully against $ManagedPath"

    # Pure managed contract checks do not instantiate Unity objects or start a scene.
    @'
using System;
using System.Reflection;
class BridgeContract {
    static MethodInfo responseCheck;
    static void Main(string[] args) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, eventArgs) => {
            var path = System.IO.Path.Combine(args[0], new AssemblyName(eventArgs.Name).Name + ".dll");
            return System.IO.File.Exists(path) ? Assembly.LoadFrom(path) : null;
        };
        var bridge = Assembly.LoadFrom(args[1]);
        var service = bridge.GetType("Warudo.Plugins.McpBridge.McpBridgeService", true);
        responseCheck = service.GetMethod("SerializeResponse", BindingFlags.Static | BindingFlags.NonPublic);
        if (responseCheck == null) throw new Exception("Response budget contract was not found.");
        CheckBudget(new { message = "small result" }, false);
        CheckBudget(new { message = new string('a', 4 * 1024 * 1024) }, true);
        CheckBudget(new { message = new string('\u6F22', 2 * 1024 * 1024) }, true);
        CheckBudget(new { message = new string('"', 3 * 1024 * 1024) }, true);
        Console.WriteLine("Bridge managed contracts passed: small response, ASCII overflow, UTF-8 overflow, escaped-JSON overflow.");
    }
    static void CheckBudget(object value, bool shouldFail) {
        try {
            responseCheck.Invoke(null, new[] { (object)"contract_test", value });
            if (shouldFail) throw new Exception("Oversized response was accepted.");
        } catch (TargetInvocationException error) {
            if (!shouldFail || error.InnerException == null || !error.InnerException.Message.Contains("limit")) throw;
        }
    }
}
'@ | Set-Content -LiteralPath $contractSource -Encoding UTF8
    $contractArgs = @('-nologo', '-target:exe', ('-out:' + $contractExe), $contractSource)
    if (Test-Path -LiteralPath $monoPath) {
        & $monoPath $CompilerPath @contractArgs
    } else {
        & $CompilerPath @contractArgs
    }
    if ($LASTEXITCODE -ne 0) { throw "Bridge contract compilation failed (exit $LASTEXITCODE)." }
    if (Test-Path -LiteralPath $monoPath) {
        & $monoPath $contractExe $ManagedPath $outputPath
    } else {
        & $contractExe $ManagedPath $outputPath
    }
    if ($LASTEXITCODE -ne 0) { throw "Bridge managed contract checks failed (exit $LASTEXITCODE)." }
} finally {
    # Exact files only; no recursive removal or wildcard filesystem operations.
    foreach ($path in @($responsePath, $outputPath, $contractSource, $contractExe)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    if (Test-Path -LiteralPath $checkRoot) { Remove-Item -LiteralPath $checkRoot }
}


