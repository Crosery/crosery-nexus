# crapi installer for Windows (Windows PowerShell 5.1+ / PowerShell 7+)
#
#   irm https://raw.githubusercontent.com/crosery/crapi/main/install.ps1 | iex
#   $env:CRAPI_KEY='sk-xxx'; irm https://raw.githubusercontent.com/crosery/crapi/main/install.ps1 | iex
#
# From cmd.exe:
#   powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/crosery/crapi/main/install.ps1 | iex"
#
# Optional env: CRAPI_KEY, CRAPI_DOWNLOAD_BASE, CRAPI_INSTALL_DIR, CRAPI_NO_SETUP=1
#
# NOTE: this file is generated from scripts/install.ps1.src and is pure ASCII on purpose.
# Windows PowerShell 5.1 decodes downloaded scripts without a charset header as Latin-1,
# which garbles UTF-8 text. Chinese messages are stored as \uXXXX escapes and decoded
# at runtime with [regex]::Unescape, so the script prints correctly in every console.
# It never calls `exit`, because `irm | iex` runs inside the user's own PowerShell session.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  function M([string]$s) { [regex]::Unescape($s) }
  function Say([string]$s) { Write-Host '  * ' -ForegroundColor Yellow -NoNewline; Write-Host $s }
  function Ok([string]$s) { Write-Host '  + ' -ForegroundColor Green -NoNewline; Write-Host $s }
  function Bad([string]$s) { Write-Host ('  x ' + $s) -ForegroundColor Red }

  try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

    $primaryBase = 'https://cdn.crosery.com/crapi'
    $officialBase = 'https://github.com/crosery/crapi/releases/latest/download'
    $candidates = @()
    if ($env:CRAPI_DOWNLOAD_BASE) {
      $candidates += $env:CRAPI_DOWNLOAD_BASE.TrimEnd('/')
    } else {
      $m1 = "https://ghfast.top/$officialBase"
      $m2 = "https://ghproxy.net/$officialBase"
      $candidates = @($primaryBase, $m1, $officialBase, $m2)
    }

    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
      'AMD64' { $a = 'amd64' }
      'ARM64' { $a = 'arm64' }
      'x86'   { $a = '386' }
      default { throw ((M '\u6682\u4e0d\u652f\u6301\u7684 CPU \u67b6\u6784\uff1a') + $arch) }
    }
    $asset = "crapi-windows-$a.exe"

    $dir = Join-Path $env:LOCALAPPDATA 'Programs\crapi'
    if ($env:CRAPI_INSTALL_DIR) { $dir = $env:CRAPI_INSTALL_DIR }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $exe = Join-Path $dir 'crapi.exe'
    $tmp = Join-Path $dir 'crapi.exe.download'

    Write-Host ''
    Write-Host ('  crapi  ' + (M 'Crosery CPA \u4e00\u952e\u63a5\u5165')) -ForegroundColor Yellow
    Write-Host ''

    $chosenBase = $null
    foreach ($cand in $candidates) {
      try {
        if ($cand -eq $primaryBase) {
          Say ((M '\u6b63\u5728\u4ece\u4e03\u725b\u4e91 CDN \u9ad8\u901f\u4e0b\u8f7d ') + $asset + '...')
        } elseif ($cand -eq $officialBase) {
          Say ((M '\u6b63\u5728\u4ece\u5b98\u65b9\u6e90\u4e0b\u8f7d ') + $asset + '...')
        } else {
          Say ((M '\u6b63\u5728\u901a\u8fc7\u52a0\u901f\u8282\u70b9\u4e0b\u8f7d ') + $asset + '...')
        }
        Invoke-WebRequest -UseBasicParsing -Uri "$cand/$asset" -OutFile $tmp -TimeoutSec 30
        $chosenBase = $cand
        break
      } catch {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not $chosenBase) {
      throw (M '\u4e0b\u8f7d\u5931\u8d25\uff0c\u5df2\u5c1d\u8bd5\u6240\u6709\u5b98\u65b9\u53ca\u955c\u50cf\u6e90\u3002\u8bf7\u68c0\u67e5\u7f51\u7edc\u8fde\u63a5\u3002')
    }

    $want = $null
    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$chosenBase/SHA256SUMS" -TimeoutSec 15).Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
      foreach ($line in ($sums -split "`n")) {
        $p = $line.Trim() -split '\s+'
        if ($p.Count -eq 2 -and $p[1].TrimStart('*') -eq $asset) { $want = $p[0] }
      }
    } catch {}
    if ($want) {
      $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash
      if ($got -ne $want.ToUpper()) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw (M '\u6821\u9a8c\u548c\u4e0d\u4e00\u81f4\uff0c\u5df2\u4e2d\u6b62\u5b89\u88c5')
      }
      Ok (M '\u6821\u9a8c\u901a\u8fc7')
    }

    # A running crapi.exe cannot be overwritten, but it can be renamed.
    if (Test-Path $exe) {
      Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue
      try { Move-Item $exe "$exe.old" -Force } catch {}
    }
    Move-Item $tmp $exe -Force
    Ok ((M '\u5df2\u5b89\u88c5\u5230 ') + $exe)

    # Add to the user PATH. Read the raw value so %VAR% entries are not expanded away,
    # and write it back with the original registry value kind.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      try { if ($raw) { $kind = $key.GetValueKind('Path') } } catch {}
      $key.SetValue('Path', (($parts + $dir) -join ';'), $kind)
      # Tell Explorer and new terminals that the environment changed.
      if (-not ('CrapiNative.Env' -as [type])) {
        Add-Type -Namespace CrapiNative -Name Env -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
      }
      $r = [UIntPtr]::Zero
      [void][CrapiNative.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
      Ok (M '\u5df2\u52a0\u5165\u7528\u6237 PATH\uff08\u65b0\u5f00\u7684\u7ec8\u7aef\u91cc\u53ef\u76f4\u63a5\u4f7f\u7528 crapi\uff09')
    }
    $key.Close()
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) { $env:Path = "$env:Path;$dir" }

    if ($env:CRAPI_NO_SETUP -eq '1') {
      Write-Host ''
      Write-Host (M '\u5b89\u88c5\u5b8c\u6210\u3002\u8fd0\u884c crapi setup \u5f00\u59cb\u914d\u7f6e\u3002')
      return
    }
    Write-Host ''
    & $exe setup
  } catch {
    Bad $_.Exception.Message
  }
}
