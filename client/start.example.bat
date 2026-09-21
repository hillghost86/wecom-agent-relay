@echo off
rem WeCom Relay Sentinel - keep this window running (or put a shortcut into shell:startup)
rem Prereq: config.json filled next to sentinel.mjs, node.exe on PATH (or edit the path below)
node "%~dp0sentinel.mjs" --interval 10
pause
