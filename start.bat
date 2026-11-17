@echo off
chcp 65001 >nul
title AppBox
cd /d "%~dp0"

where python >nul 2>nul
if not errorlevel 1 goto usepython

where py >nul 2>nul
if not errorlevel 1 goto usepy

echo.
echo  没有检测到 Python，无法启动 AppBox 服务。
echo  请先安装 Python 3：https://www.python.org/downloads/
echo  安装时记得勾选 "Add Python to PATH"。
echo.
pause
exit /b 1

:usepython
python server.py
goto end

:usepy
py server.py

:end
echo.
echo  AppBox 服务已停止。
pause
