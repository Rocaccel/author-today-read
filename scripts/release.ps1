<#
  release.ps1 — автоматизация AGENTS.md §9 (релизы) одной командой.

  Использование (из корня проекта):
    npm run release -- -BuildOnly          # только собрать zip/crx в dist/ (без тега/публикации)
    npm run release                        # полный флоу §9: проверки → zip/crx → тег → gh release
    npm run release -- -Title "v0.2.5 — тумблер" -Notes "…"   # вручную ноты/заголовок
    npm run release -- -Version 0.2.6      # версия не из manifest.json
    npm run release -- -Chrome "C:\...\chrome.exe"  # свой chromium для --pack-extension

  Что делает (§9):
    1. Preconditions: дерево чистое, main == origin/main, тега ещё нет, есть
       extension.pem и gh CLI (в -BuildOnly — только проверка конфига).
    2. databaseURL: npm run config (парсер .env — scripts/apply-config.js).
    3. ZIP: содержимое extension/ путями через "/" (.NET CreateEntry, не
       Compress-Archive — тот пишет "\"), плюс background/config.json
       ТОЛЬКО с полем databaseURL (остальные поля .env в ассет не класть).
    4. CRX: копия extension/ во временной папке + тот же trimmed config →
       chromium --pack-extension=… --pack-extension-key=extension.pem →
       dist/author-today-read-X.Y.Z.crx (один ключ = стабильный ID).
    5. Publish: git tag vX.Y.Z → git push origin main vX.Y.Z →
       gh release create vX.Y.Z <zip> <crx> --title --notes.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Title,
    [string]$Notes,
    [string]$Chrome,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

function Fail([string]$msg) {
    Write-Host "[release] ОШИБКА: $msg" -ForegroundColor Red
    exit 1
}
function Step([string]$msg) {
    Write-Host "[release] $msg"
}

# --- версия ---------------------------------------------------------------
if (-not $Version) {
    $mf = Get-Content (Join-Path $ROOT 'extension\manifest.json') -Raw | ConvertFrom-Json
    $Version = $mf.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "некорректная версия: '$Version'" }
$tag = "v$Version"
Step "версия $Version (тег $tag)"

# --- конфиг databaseURL (§9.4) -------------------------------------------
$envPath = Join-Path $ROOT '.env'
if (-not (Test-Path $envPath)) { Fail ".env не найден (нужен FIREBASE_DATABASE_URL)" }
Push-Location $ROOT
try {
    npm run config
    if ($LASTEXITCODE -ne 0) { Fail "npm run config завершился с ошибкой" }
} finally { Pop-Location }
$cfgPath = Join-Path $ROOT 'extension\background\config.json'
if (-not (Test-Path $cfgPath)) { Fail "config.json не создан" }
$dbUrl = (Get-Content $cfgPath -Raw | ConvertFrom-Json).databaseURL
if (-not $dbUrl) { Fail "FIREBASE_DATABASE_URL пустой — без него релиз не работает из коробки (§9.4)" }
# trimmed-конфиг для ассетов: ровно одно поле
$trimJson = '{"databaseURL": ' + ($dbUrl | ConvertTo-Json) + '}'
Step "databaseURL получен"

# --- preconditions публикации (в -BuildOnly пропускаются) -----------------
if (-not $BuildOnly) {
    $st = git status --porcelain
    if ($st) { Fail "рабочее дерево не чистое (сначала закоммитьте)" }
    $branch = git branch --show-current
    if ($branch -ne 'main') { Fail "нужно быть в ветке main (сейчас: '$branch')" }
    git fetch origin
    if ($LASTEXITCODE -ne 0) { Fail "git fetch failed" }
    $ahead = git rev-list --count 'origin/main..main'
    $behind = git rev-list --count 'main..origin/main'
    if ($ahead -ne 0 -or $behind -ne 0) { Fail "main не синхронизирован с origin/main (ahead=$ahead behind=$behind)" }
    if (git tag --list $tag) { Fail "тег $tag уже существует" }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail "gh CLI не найден" }
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { Fail "gh не авторизован (gh auth login)" }
    Step "preconditions ok"
}

if (-not (Test-Path (Join-Path $ROOT 'extension.pem'))) { Fail "нет extension.pem (нужен для стабильного ID расширения)" }

# --- staging: копия extension/ без полного config.json ---------------------
$staging = Join-Path $env:TEMP "atr-release-$Version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item (Join-Path $ROOT 'extension\*') -Destination $staging -Recurse -Force
$stagedCfg = Join-Path $staging 'background\config.json'
Remove-Item $stagedCfg -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($stagedCfg, $trimJson)   # UTF8 без BOM
Step "staging собран: $staging"

# --- ZIP (§9.2): пути через "/" ------------------------------------------
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dist = Join-Path $ROOT 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zipPath = Join-Path $dist "author-today-read-$Version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem $staging -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
    }
} finally { $zip.Dispose() }
Step "ZIP: $zipPath"

# --- CRX (§9.3): --pack-extension с extension.pem -------------------------
if (-not $Chrome) {
    $candidates = @()
    $candidates += Get-ChildItem 'D:\Загрузки' -Directory -Filter 'ungoogled-chromium*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'chrome.exe' }
    $candidates += 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    $candidates += 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
    $candidates += 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    $Chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Chrome) { Fail "chromium/chrome не найден — укажите -Chrome <путь>" }

$crxStageRoot = Join-Path $env:TEMP "atr-crx-$Version"
if (Test-Path $crxStageRoot) { Remove-Item $crxStageRoot -Recurse -Force }
$crxDir = Join-Path $crxStageRoot 'author-today-read'
New-Item -ItemType Directory -Path $crxDir | Out-Null
Copy-Item (Join-Path $ROOT 'extension\*') -Destination $crxDir -Recurse -Force
Remove-Item (Join-Path $crxDir 'background\config.json') -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText((Join-Path $crxDir 'background\config.json'), $trimJson)

$crxOut = "$crxDir.crx"
if (Test-Path $crxOut) { Remove-Item $crxOut -Force }
& $Chrome "--pack-extension=$crxDir" "--pack-extension-key=$(Join-Path $ROOT 'extension.pem')" 2>&1 | ForEach-Object { Step "  chromium: $_" }
# chromium может отдать управление раньше, чем допишет crx — ждём до 30 с
$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-Path $crxOut) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $crxOut)) { Fail "crx не появился: $crxOut" }
$crxPath = Join-Path $dist "author-today-read-$Version.crx"
Move-Item $crxOut $crxPath -Force
Step "CRX: $crxPath"

# --- publish (§9.1, §9.5) -------------------------------------------------
if ($BuildOnly) {
    Step "BuildOnly — тег/публикация пропущены. Артефакты в dist/"
    exit 0
}

$prev = git tag --list 'v*' --sort=-v:refname | Where-Object { $_ -ne $tag } | Select-Object -First 1
if (-not $Notes) {
    if ($prev) { $notesLines = git log --oneline "$prev..HEAD" } else { $notesLines = git log --oneline }
    if (-not $notesLines) { $notesLines = @("$tag") }
    $Notes = [string]::Join("`n", @($notesLines))
}
if (-not $Title) {
    $range = if ($prev) { "$prev..HEAD" } else { $null }
    $feat = if ($range) { git log --format='%s' $range | Where-Object { $_ -match '^(feat|fix)' } | Select-Object -First 1 } else { $null }
    $Title = if ($feat) { "$tag — $feat" } else { $tag }
}

git tag $tag main
if ($LASTEXITCODE -ne 0) { Fail "git tag failed" }
# явный refs/tags/: имя может совпадать с локальной веткой (v0.2.5 и т.п.)
git push origin main "refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { Fail "git push failed" }
Step "тег $tag запушен"

gh release create $tag $zipPath $crxPath --title $Title --notes $Notes
if ($LASTEXITCODE -ne 0) { Fail "gh release create failed" }
Step "релиз $tag опубликован: https://github.com/Rocaccel/author-today-read/releases/tag/$tag"
