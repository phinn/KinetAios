@echo off
REM ============================================================
REM  KinetAios data recovery: expose 8/7 shadow snapshot -^> copy 3 data dirs
REM  MUST run as Administrator. ASCII-only to avoid GBK/UTF-8 mess.
REM ============================================================
chcp 437 >nul
echo [1/4] Exposing shadow snapshot as S: ...
(
echo set context volatile nowriters
echo add volume C: alias snap
echo create
echo expose %%snap%% S:
echo exit
) | "%SystemRoot%\System32\diskshadow.exe"
if not exist S:\ (
    echo [ERROR] S: not created. No shadow copy or diskshadow failed.
    pause
    exit /b 1
)

echo [2/4] Copying KinetAios dir ...
robocopy S:\Users\dmsdep\AppData\Roaming\KinetAios C:\KinetAios-Snapshot0807 /E /B /NFL /NDL /NJH
echo [3/4] Copying kinetaios-win dir ...
robocopy S:\Users\dmsdep\AppData\Roaming\kinetaios-win C:\kinetaios-win-0807 /E /B /NFL /NDL /NJH
echo      Copying SchAgent dir ...
robocopy S:\Users\dmsdep\AppData\Roaming\SchAgent C:\SchAgent-0807 /E /B /NFL /NDL /NJH

echo [4/4] Result check:
for %%D in (C:\KinetAios-Snapshot0807 C:\kinetaios-win-0807 C:\SchAgent-0807) do (
    if exist %%D\history.db (
        echo   %%D\history.db FOUND:
        dir %%D\history.db* | findstr history
    ) else (
        echo   %%D no history.db
    )
)

echo.
echo DONE. Send the db file sizes/times above to the AI.
echo (Snapshot kept, NOT deleted.)
pause
