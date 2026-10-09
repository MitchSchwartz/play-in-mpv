@echo off
rem Native messaging entry point for Windows. Chrome runs this .bat; it starts the
rem Python helper with the same arguments. Stream data arrives on stdin, never here.
rem Uses python on PATH; falls back to the Python launcher (py -3) if python is
rem missing or is the Microsoft Store stub (which exits with an error).
python --version >nul 2>nul
if errorlevel 1 goto use_py
python "%~dp0play_in_mpv_host.py" %*
exit /b %errorlevel%

:use_py
py -3 "%~dp0play_in_mpv_host.py" %*
exit /b %errorlevel%
