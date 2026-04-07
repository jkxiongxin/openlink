$ErrorActionPreference = "Stop"

$REPO = "afumu/openlink"
$BIN = "openlink"
$INSTALL_DIR = Join-Path $env:USERPROFILE ".openlink"

function Get-Arch {
    if ([Environment]::Is64BitOperatingSystem) {
        return "amd64"
    }
    return "386"
}

function Get-LatestVersion {
    param([string]$Repo)

    $response = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -MaximumRedirection 0 -ErrorAction SilentlyContinue
    if (-not $response.Headers.Location) {
        return $null
    }

    return $response.Headers.Location -replace ".*/tag/", ""
}

function Install-FromDirectory {
    param([string]$SourceDir)

    $sourceExe = Join-Path $SourceDir "$BIN.exe"
    if (-not (Test-Path $sourceExe)) {
        throw "Missing $BIN.exe in $SourceDir"
    }

    New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
    Copy-Item -Force $sourceExe (Join-Path $INSTALL_DIR "$BIN.exe")
}

function Add-ToUserPath {
    $current = [Environment]::GetEnvironmentVariable("PATH", "User")
    $segments = @()
    if ($current) {
        $segments = $current -split ';' | Where-Object { $_ -and $_.Trim() }
    }

    if ($segments -notcontains $INSTALL_DIR) {
        $nextPath = if ($current) { "$current;$INSTALL_DIR" } else { $INSTALL_DIR }
        [Environment]::SetEnvironmentVariable("PATH", $nextPath, "User")
        Write-Host "Added $INSTALL_DIR to the user PATH. Restart the terminal to pick it up."
    }
}

$localExe = Join-Path $PSScriptRoot "$BIN.exe"
if (Test-Path $localExe) {
    Write-Host "Installing from the extracted release package..."
    Install-FromDirectory -SourceDir $PSScriptRoot
} else {
    $arch = Get-Arch
    $version = Get-LatestVersion -Repo $REPO
    if (-not $version) {
        throw "Failed to determine the latest release version."
    }

    $file = "${BIN}_windows_${arch}.zip"
    $url = "https://github.com/$REPO/releases/download/$version/$file"
    Write-Host "Downloading openlink $version ($arch)..."

    $tmp = Join-Path $env:TEMP "openlink_install"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $zipPath = Join-Path $tmp "openlink.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath
        Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
        Install-FromDirectory -SourceDir $tmp
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

Add-ToUserPath

Write-Host "Installed: $INSTALL_DIR\$BIN.exe"
Write-Host "Run 'openlink' to start the server."
