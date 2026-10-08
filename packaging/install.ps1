# Installs the shoal binary on Windows (PowerShell 5.1 or 7):
#
#   irm https://raw.githubusercontent.com/TheDevper/shoal/main/packaging/install.ps1 | iex
#
# $env:SHOAL_VERSION = '0.1.0'       a specific release instead of the latest
# $env:SHOAL_INSTALL_DIR = 'C:\...'  where to put shoal.exe (default %LOCALAPPDATA%\Programs\shoal)
# $env:SHOAL_DOWNLOAD_BASE = '...'   where the release files are (a URL or folder, for testing)

# A script block keeps preferences and variables out of the caller's session under `iex`.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # the progress bar makes Invoke-WebRequest very slow
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'TheDevper/shoal'
  # x64 also runs on Windows on ARM through emulation.
  $Target = 'windows-x64'
  $InstallDir = if ($env:SHOAL_INSTALL_DIR) { $env:SHOAL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\shoal' }

  $Version = $env:SHOAL_VERSION
  if (-not $Version) {
    $Version = (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest").tag_name
  }
  $Version = "$Version".TrimStart('v')
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Unexpected shoal version '$Version'" }
  $Base = if ($env:SHOAL_DOWNLOAD_BASE) { $env:SHOAL_DOWNLOAD_BASE } else { "https://github.com/$Repo/releases/download/v$Version" }
  $Archive = "shoal-v$Version-$Target.zip"

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("shoal-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  try {
    $fetch = {
      param($Name)
      $to = Join-Path $Tmp $Name
      if ($Base -match '^https?://') { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name" -OutFile $to }
      else { Copy-Item -LiteralPath (Join-Path $Base $Name) -Destination $to }
      $to
    }
    Write-Host "Downloading shoal $Version ($Target)"
    $zip = & $fetch $Archive
    $expected = Get-Content (& $fetch 'SHA256SUMS') |
      ForEach-Object { $f = $_ -split '\s+'; if ($f[1] -eq $Archive) { $f[0] } } |
      Select-Object -First 1
    if (-not $expected) { throw "SHA256SUMS has no entry for $Archive" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
    if ($expected -ne $actual) { throw "Checksum mismatch for $Archive" }

    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $Tmp 'out') -Force
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $exe = Join-Path $InstallDir 'shoal.exe'
    # A running shoal.exe (say, `shoal mcp` under an agent) cannot be overwritten but can be renamed.
    $old = "$exe.old"
    Remove-Item -Force -LiteralPath $old -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $exe) { Move-Item -Force -LiteralPath $exe -Destination $old }
    Copy-Item -Force (Join-Path $Tmp 'out\shoal.exe') $exe
    Remove-Item -Force -LiteralPath $old -ErrorAction SilentlyContinue
  } finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }

  # Add the folder to the user's PATH through the registry: the .NET Environment API would expand
  # entries like %USERPROFILE% and write the value back as a plain string.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ';' | Where-Object { $_ })
    $known = $parts | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') }
    if ($known -notcontains $InstallDir.TrimEnd('\')) {
      $kind = if ($raw -and $key.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::String) { 'String' } else { 'ExpandString' }
      $key.SetValue('Path', (($parts + $InstallDir) -join ';'), $kind)
      # Tell running programs (Explorer, new terminals) that the environment changed.
      [Environment]::SetEnvironmentVariable('SHOAL_INSTALL_PING', '1', 'User')
      [Environment]::SetEnvironmentVariable('SHOAL_INSTALL_PING', $null, 'User')
      Write-Host "Added $InstallDir to your PATH (new terminals pick it up)."
    }
  } finally {
    $key.Close()
  }
  if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path = "$env:Path;$InstallDir" }

  $installed = & (Join-Path $InstallDir 'shoal.exe') --version
  Write-Host "Installed $installed to $InstallDir"
  Write-Host ''
  Write-Host 'Start: mkdir ~\shoal; cd ~\shoal; shoal init --name <you> --key <KEY>; shoal web'
}
