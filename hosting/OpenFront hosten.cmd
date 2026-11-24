@echo off
title openfront v2 - Hosting
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-openfront.ps1" %*
