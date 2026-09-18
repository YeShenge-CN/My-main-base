# =====================================================================
#  编译 一键启动器
#  使用 Windows 自带的 .NET Framework 编译器 (csc.exe)，无需联网、无需安装 SDK
#  用法： powershell -ExecutionPolicy Bypass -File launcher\build.ps1
# =====================================================================
$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$root   = Split-Path -Parent $here
$source = Join-Path $here 'Program.cs'
$out    = Join-Path $root '启动校园二手交易平台.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw '找不到 csc.exe，请确认已安装 .NET Framework 4.x' }

$refs = @('System.dll', 'System.Core.dll', 'System.ServiceProcess.dll')
$refArgs = $refs | ForEach-Object { '/r:' + $_ }

Write-Host '正在编译 ...' -ForegroundColor Cyan
& $csc /nologo /target:exe /platform:anycpu /optimize+ /utf8output /warn:4 `
       $refArgs /out:"$out" "$source"

if ($LASTEXITCODE -ne 0) { throw "编译失败，错误码 $LASTEXITCODE" }

$item = Get-Item $out
Write-Host ('编译成功：' + $item.FullName + '  (' + [math]::Round($item.Length / 1KB, 1) + ' KB)') -ForegroundColor Green
