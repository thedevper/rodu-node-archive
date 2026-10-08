# CI only: installs shoal the way Windows users do (irm | iex) from the freshly built release
# files, checks the user PATH survives, upgrades while shoal runs, then smoke-tests the binary.
$ErrorActionPreference = 'Stop'
$env:SHOAL_VERSION = node -p "require('./apps/cli/package.json').version"
$env:SHOAL_INSTALL_DIR = "$env:RUNNER_TEMP\shoal"
$env:SHOAL_DOWNLOAD_BASE = "$env:GITHUB_WORKSPACE\dist\release"
# An expandable entry like the Windows default %USERPROFILE%\...\WindowsApps must survive.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$before = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$key.SetValue('Path', ($before.TrimEnd(';') + ';%USERPROFILE%\shoal-ci-marker').TrimStart(';'), 'ExpandString')
Get-Content -Raw packaging/install.ps1 | Invoke-Expression
$after = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
if ($key.GetValueKind('Path') -ne 'ExpandString') { throw 'user PATH lost REG_EXPAND_SZ' }
if ($after -notlike '*%USERPROFILE%\shoal-ci-marker*') { throw "user PATH was expanded: $after" }
if ($after -notlike "*$env:SHOAL_INSTALL_DIR*") { throw 'install dir not on user PATH' }
# A second run upgrades in place while shoal.exe is running.
$ws = New-Item -ItemType Directory -Force "$env:RUNNER_TEMP\ws"
Push-Location $ws; shoal init --name ci --key CI; Pop-Location
$running = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $ws "$env:SHOAL_INSTALL_DIR\shoal.exe" -ArgumentList 'web', '--no-open', '--port', '0'
Start-Sleep -Seconds 2
if ($running.HasExited) { throw 'shoal web did not keep running' }
Get-Content -Raw packaging/install.ps1 | Invoke-Expression
# Again, while the first renamed copy is still running.
Get-Content -Raw packaging/install.ps1 | Invoke-Expression
Stop-Process -Id $running.Id -Force
shoal --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/smoke-binary.ts "$env:SHOAL_INSTALL_DIR\shoal.exe"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
