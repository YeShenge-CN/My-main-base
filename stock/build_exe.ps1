# ============================================================
#  一键启动器打包脚本
#  用法:  powershell -ExecutionPolicy Bypass -File build_exe.ps1
#  产物:  dist\股票预测一键启动.exe
# ============================================================
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$venvPy = Join-Path $root ".venv\Scripts\python.exe"
$py = if (Test-Path $venvPy) { $venvPy } else { "python" }

Write-Host "==> 使用解释器: $py" -ForegroundColor Cyan

# 1. 确保 PyInstaller 存在
& $py -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "==> 正在安装 PyInstaller ..." -ForegroundColor Yellow
    & $py -m pip install pyinstaller --no-input
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 安装失败" }
}

# 2. 生成图标（Pillow 缺失时自动跳过）
$icon = Join-Path $root "icon.ico"
if (-not (Test-Path $icon)) {
    & $py (Join-Path $root "make_icon.py")
}

# 3. 清理旧产物
foreach ($d in @("build", "dist")) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
}

# 4. 打包（单文件 + 控制台窗口，便于查看启动日志）
Write-Host "==> 正在打包，请稍候 ..." -ForegroundColor Cyan
$args = @(
    "--noconfirm", "--clean", "--onefile", "--console",
    "--name", "股票预测一键启动",
    "--hidden-import=webbrowser",
    (Join-Path $root "launcher.py")
)
if (Test-Path $icon) { $args = @("--icon", $icon) + $args }

& $py -m PyInstaller @args

if ($LASTEXITCODE -ne 0) { throw "PyInstaller 打包失败" }

$exe = Join-Path $root "dist\股票预测一键启动.exe"
if (-not (Test-Path $exe)) { throw "未生成 exe: $exe" }

Write-Host ""
Write-Host "==> 打包成功!" -ForegroundColor Green
Write-Host "    产物: $exe" -ForegroundColor Green
Write-Host ("    大小: {0:N1} MB" -f ((Get-Item $exe).Length / 1MB))
Write-Host ""
Write-Host "提示: 把该 exe 放在项目根目录（与 app.py 同级）即可双击运行。" -ForegroundColor Gray
