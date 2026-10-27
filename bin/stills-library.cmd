@echo off
setlocal
rem Bundled CLI launcher. Electron supplies its own Node runtime.
if not defined STILLS_LIBRARY_APP_EXECUTABLE set "STILLS_LIBRARY_APP_EXECUTABLE=%~dp0..\..\Stills Library.exe"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Stills Library.exe" "%~dp0..\app.asar\dist\cli.cjs" %*
exit /b %errorlevel%
