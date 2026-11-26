@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [x] 找不到 python。请先安装 Python 3.10+ 并勾选 "Add to PATH"。
  pause
  exit /b 1
)

echo 即将关闭并重启 WorkBuddy，把工作台注入到客户端（约 40 秒）。
echo 失败会自动还原，详见 tools\install.log。
echo.
python "tools\install.py"
echo.
pause
