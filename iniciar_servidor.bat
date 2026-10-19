@echo off
REM Arranca el backend real de Mi Diario en http://127.0.0.1:8000 (datos en backend\agenda.db).
REM Con Tailscale, "tailscale serve --bg 8000" lo publica para tus dispositivos en https://<tu-pc>.<tu-red>.ts.net
REM Deja esta ventana abierta mientras quieras que el telefono sincronice.
cd /d "%~dp0backend"
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
