@echo off
rem LearnHarness Windows installer build - the steps in docs/desktop-release.md
rem ("Local packaging": steps 1-6, then electron-builder --win --x64 --publish never).
rem Output goes to build\build-windows.log next to this file.
setlocal
rem Lives in build\; everything runs from the repo root one level up.
cd /d "%~dp0.."
set "LOG=%~dp0build-windows.log"
set NEXT_TELEMETRY_DISABLED=1
echo [%date% %time%] LearnHarness Windows build starting > "%LOG%"

call :step "toolchain: node" "node -v" || goto :fail
call :step "toolchain: npm" "npm -v" || goto :fail
rem The build scripts need node:module registerHooks and the Pi packages need Node >= 22.19 (CI uses Node 26).
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)" || (
  echo Node is too old for this repo: install Node 26 ^(what CI uses^) or at least 22.19, then run this again. >> "%LOG%"
  echo Node is too old for this repo: install Node 26 ^(what CI uses^) or at least 22.19, then run this again.
  goto :fail
)
call :step "1/7 npm ci" "npm ci" || goto :fail
set NODE_ENV=test
set ELECTRON_RUN_AS_NODE=1
call :step "2/7 native renderer tests" "npx electron --import tsx --test tests/pdf-native-render.test.ts tests/pdf-ops.test.ts tests/svg-native-render.test.ts tests/browser-service.test.ts" || goto :fail
set NODE_ENV=
set ELECTRON_RUN_AS_NODE=
call :step "3/7 next build" "npm run build" || goto :fail
call :step "4/7 provider runtime smoke" "node scripts/smoke-provider-runtime.mjs" || goto :fail
call :step "5/7 curate server payload" "node scripts/build-server.mjs" || goto :fail
call :step "6/7 server smoke, Electron runtime" "node scripts/smoke-server.mjs --electron" || goto :fail
call :step "7/7 electron-builder" "npx electron-builder --win --x64 --publish never" || goto :fail

echo [%date% %time%] BUILD OK >> "%LOG%"
echo.
echo BUILD OK - installer is in the dist folder.
dir /b dist\*.exe >> "%LOG%" 2>&1
pause
exit /b 0

:fail
echo [%date% %time%] BUILD FAILED >> "%LOG%"
echo.
echo BUILD FAILED - see build-windows.log
pause
exit /b 1

:step
echo.
echo === %~1
echo. >> "%LOG%"
echo [%date% %time%] === %~1 >> "%LOG%"
call %~2 >> "%LOG%" 2>&1
rem No parenthesized block here: a ")" in a step label would end it early.
if errorlevel 1 goto :stepfail
exit /b 0

:stepfail
echo [%date% %time%] step failed: %~1 >> "%LOG%"
exit /b 1
