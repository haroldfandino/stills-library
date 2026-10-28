[CmdletBinding()]
param(
    [string]$Python,
    [string]$ExtractRoot,
    [string]$RenameScript,
    [string]$FfmpegDir,
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ExtractRoot) { $ExtractRoot = Join-Path $PSScriptRoot '..\..\extract-stills' }
if (-not $RenameScript) { $RenameScript = Join-Path $PSScriptRoot '..\..\postproduction-tools\Rename_stills\rename_stills.py' }
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'Run this helper on Windows x64.'
}
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$extractDirectory = (Resolve-Path -LiteralPath $ExtractRoot).Path
$renameSource = (Resolve-Path -LiteralPath $RenameScript).Path
if (-not (Test-Path -LiteralPath (Join-Path $extractDirectory 'build_app.py'))) {
    throw "Not an Extract Stills checkout: $extractDirectory"
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable exited with code $LASTEXITCODE."
    }
}

$venvPython = Join-Path $extractDirectory '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    $candidates = @()
    if ($Python) {
        $candidates = @((Resolve-Path -LiteralPath $Python).Path)
    } else {
        # py -3.12 does not select every registered runtime (including uv's).
        # Inspect the launcher inventory and verify the actual interpreter.
        if (Get-Command py -ErrorAction SilentlyContinue) {
            $inventory = & py -0p 2>$null
            foreach ($line in $inventory) {
                if ($line -match '\s([A-Za-z]:\\.+\\python\.exe)\s*$') {
                    $candidates += $Matches[1]
                }
            }
        }
        $systemPython = Get-Command python -ErrorAction SilentlyContinue
        if ($systemPython) { $candidates += $systemPython.Source }
    }
    $selectedPython = $null
    foreach ($candidate in $candidates | Select-Object -Unique) {
        $version = & $candidate -c "import platform, sys; print(f'{sys.version_info.major}.{sys.version_info.minor}:{platform.machine().lower()}')" 2>$null
        if ($LASTEXITCODE -eq 0 -and $version -in @('3.12:amd64', '3.12:x86_64')) {
            $selectedPython = $candidate
            break
        }
    }
    if (-not $selectedPython) {
        throw 'Install Python 3.12 x64 or pass -Python with its full python.exe path.'
    }
    Invoke-Checked $selectedPython @('-m', 'venv', (Join-Path $extractDirectory '.venv'))
}
Invoke-Checked $venvPython @('-c', "import platform, sys; assert sys.version_info[:2] == (3, 12) and platform.machine().lower() in ('amd64', 'x86_64'), 'The existing .venv must use Python 3.12 x64.'")
Invoke-Checked $venvPython @('-m', 'pip', 'install', '-r', (Join-Path $extractDirectory 'requirements-dev.txt'))
Invoke-Checked $venvPython @((Join-Path $extractDirectory 'scripts\setup_models.py'))

$corePath = Join-Path $extractDirectory 'stills_tool\core.py'
if ((Get-Content -LiteralPath $corePath -Raw).Contains('"-filter_script:v"')) {
    $patch = Join-Path $repoRoot 'patches\extract-stills-ffmpeg9.patch'
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', '--check', $patch)
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', $patch)
}
if ((Get-Content -LiteralPath $corePath -Raw).Contains('cv2.imwrite(str(path), frame')) {
    $patch = Join-Path $repoRoot 'patches\extract-stills-unicode-paths.patch'
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', '--check', $patch)
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', $patch)
}

if (-not (Get-Content -LiteralPath $corePath -Raw).Contains('str(directory).replace("%", "%%")')) {
    $patch = Join-Path $repoRoot 'patches\extract-stills-percent-paths.patch'
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', '--check', $patch)
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', $patch)
}

$ocrPath = Join-Path $extractDirectory 'stills_tool\text_ocr.py'
if (-not (Get-Content -LiteralPath $ocrPath -Raw).Contains('recognition_error=str(error)')) {
    $patch = Join-Path $repoRoot 'patches\extract-stills-degenerate-text.patch'
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', '--check', $patch)
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', $patch)
}
if (-not (Get-Content -LiteralPath $corePath -Raw).Contains('def _mov_input_options(')) {
    $patch = Join-Path $repoRoot 'patches\extract-stills-mov-chapters.patch'
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', '--check', $patch)
    Invoke-Checked 'git' @('-C', $extractDirectory, 'apply', $patch)
}
$buildArguments = @((Join-Path $PSScriptRoot 'build-native.py'), '--extract-root', $extractDirectory, '--rename-script', $renameSource)
if ($FfmpegDir) {
    $buildArguments += @('--ffmpeg-dir', (Resolve-Path -LiteralPath $FfmpegDir).Path)
}
Invoke-Checked $venvPython ($buildArguments + @('--check'))
if ($Build) {
    Invoke-Checked $venvPython $buildArguments
} else {
    Write-Output 'Windows prerequisites are ready. Run this helper with -Build to create and verify the native bundle.'
}
