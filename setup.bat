@echo off
setlocal
cd /d "%~dp0"
echo ==================================================
echo   DSH Client 引导安装（首次运行，约 1-3 分钟）
echo ==================================================
if exist "DSH Client.exe" (
  echo 已安装过；如需重装请先删除 DSH Client.exe
  pause
  exit /b 0
)

set ELECTRON_URL=https://npmmirror.com/mirrors/electron/v33.4.11/electron-v33.4.11-win32-x64.zip
if exist electron-setup.zip del electron-setup.zip

echo [1/3] 下载 Electron 运行时（约 115MB，国内镜像）...
where curl >nul 2>&1
if %errorlevel%==0 (
  curl -L -sS --retry 3 -o electron-setup.zip "%ELECTRON_URL%"
) else (
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; [System.Net.WebRequest]::DefaultWebProxy=$null; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%ELECTRON_URL%' -OutFile electron-setup.zip -UseBasicParsing"
)

set ZIPSIZE=0
if exist electron-setup.zip for %%F in (electron-setup.zip) do set ZIPSIZE=%%~zF
if %ZIPSIZE% LSS 50000000 (
  echo 下载失败或不完整（%ZIPSIZE% 字节）：请检查网络后重新运行本脚本
  if exist electron-setup.zip del electron-setup.zip
  pause
  exit /b 1
)

echo [2/3] 解压并组装客户端...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Expand-Archive -Path electron-setup.zip -DestinationPath electron-setup -Force"
if not exist electron-setup\electron.exe (
  echo 解压失败：下载文件可能损坏，请重新运行本脚本
  rd /s /q electron-setup 2>nul
  del electron-setup.zip 2>nul
  pause
  exit /b 1
)
powershell -NoProfile -Command "Copy-Item 'electron-setup\*' -Destination . -Recurse -Force"
ren electron.exe "DSH Client.exe"
rd /s /q electron-setup
del electron-setup.zip

echo [3/3] 设置应用图标...
if exist rcedit-x64.exe (
  rcedit-x64.exe "DSH Client.exe" --set-icon icon.ico --set-version-string ProductName "DSH Client" --set-version-string FileDescription "DeepSeek Harness Client"
)

echo.
echo 安装完成！双击「DSH Client.exe」启动，
echo 首次使用请在 设置 - Harness 更新 中点「检查并更新」完成部署。
pause
