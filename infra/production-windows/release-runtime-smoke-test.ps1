[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$deployFile = Join-Path $PSScriptRoot 'deploy.ps1'
foreach ($script in @($deployFile, (Join-Path $PSScriptRoot 'build-release.ps1'))) {
    $tokens = $null; $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count) { throw "PowerShell parse failed: $script" }
}

# Execute only runtime staging/validation from the actual deploy script. No services,
# junctions, release promotion, production paths, downloads or health endpoints.
$source = [IO.File]::ReadAllText($deployFile)
$start = $source.IndexOf('            $runtime = Get-Content', [StringComparison]::Ordinal)
$end = $source.IndexOf('            Move-Item -LiteralPath $unpacked', [StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start) { throw 'Runtime validation block was not found' }
$validate = [scriptblock]::Create($source.Substring($start, $end - $start))
$workflow = [IO.File]::ReadAllText((Join-Path $repository '.github\workflows\ci-deploy.yml'))
$releaseJob = [regex]::Match($workflow, '(?ms)^  release:\s*$(.*?)^  deploy:').Groups[1].Value
if ($releaseJob -notmatch '(?m)^    environment:\s*$' -or
    $releaseJob -notmatch '(?m)^      name: production\s*$' -or
    $workflow -notmatch '(?m)^  cancel-in-progress: false\s*$') {
    throw 'Production gate must precede release publication without cancelling an active release'
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('weblens-release-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function New-Fixture([string]$Name, [bool]$Bundled) {
    $directory = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $directory 'capture-worker\migrations\postgresql') -Force | Out-Null
    if ($Bundled) {
        New-Item -ItemType Directory -Path (Join-Path $directory 'capture-worker\node_modules'), (Join-Path $directory 'capture-worker\camoufox') | Out-Null
        [IO.File]::WriteAllText((Join-Path $directory 'capture-worker\node_modules\.package-lock.json'), 'fixture-lock')
        [IO.File]::WriteAllText((Join-Path $directory 'capture-worker\camoufox\camoufox.exe'), 'fixture-browser')
    }
    [IO.File]::WriteAllText((Join-Path $directory 'capture-worker\migrations\postgresql\001.sql'), 'select 1;')
    return $directory
}

function Write-Runtime([string]$Target, [string]$RuntimeSource) {
    $manifest = @{
        nodeModulesLockSha256 = (Get-FileHash -LiteralPath (Join-Path $RuntimeSource 'capture-worker\node_modules\.package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        camoufoxExeSha256 = (Get-FileHash -LiteralPath (Join-Path $RuntimeSource 'capture-worker\camoufox\camoufox.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText((Join-Path $Target 'capture-worker\runtime.json'), ($manifest | ConvertTo-Json -Compress))
}

function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
    $failed = $false
    try { & $Action } catch {
        $failed = $true
        if ($_.Exception.Message -notmatch $Pattern) { throw }
    }
    if (-not $failed) { throw "Expected rejection: $Pattern" }
}

try {
    $previous = $null
    $unpacked = New-Fixture 'first-install' $true
    Write-Runtime $unpacked $unpacked
    . $validate

    $previous = $unpacked
    $unpacked = New-Fixture 'bundled-upgrade' $true
    [IO.File]::WriteAllText((Join-Path $unpacked 'capture-worker\node_modules\.package-lock.json'), 'new-lock')
    Write-Runtime $unpacked $unpacked
    . $validate # A new dependency runtime need not match the previous release.

    $unpacked = New-Fixture 'legacy-compatible' $false
    Write-Runtime $unpacked $previous
    . $validate
    if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'capture-worker\camoufox\camoufox.exe'))) { throw 'Legacy runtime was not copied' }

    $unpacked = New-Fixture 'legacy-incompatible' $false
    Write-Runtime $unpacked (Join-Path $testRoot 'bundled-upgrade')
    Expect-Failure { . $validate } 'checksum does not match'

    $unpacked = New-Fixture 'tampered-runtime' $true
    Write-Runtime $unpacked $unpacked
    [IO.File]::WriteAllText((Join-Path $unpacked 'capture-worker\camoufox\camoufox.exe'), 'tampered')
    Expect-Failure { . $validate } 'checksum does not match'

    $unpacked = New-Fixture 'tampered-migration' $true
    Write-Runtime $unpacked $unpacked
    [IO.File]::WriteAllText((Join-Path $unpacked 'capture-worker\migrations\postgresql\001.sql'), 'select 2;')
    Expect-Failure { . $validate } 'migration changed or disappeared'

    $unpacked = New-Fixture 'legacy-first-install' $false
    Write-Runtime $unpacked $previous
    $previous = $null
    Expect-Failure { . $validate } 'runtime is unavailable'
    Write-Output 'Release runtime smoke: 7 scenarios passed; scripts parse and static approval-gate check passed.'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\weblens-release-test-'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup target' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
