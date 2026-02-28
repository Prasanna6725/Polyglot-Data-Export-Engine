@echo off
setlocal enabledelayedexpansion

REM Create JSON export
echo Creating JSON export...
for /f "tokens=2 delims={" %%A in ('curl -s -X POST http://localhost:8080/exports -H "Content-Type: application/json" -d "{\"format\":\"json\",\"columns\":[{\"source\":\"id\",\"target\":\"id\"}]}"') do (
  set "response=%%A"
)
echo Response: !response!

REM Extract ID using PowerShell
for /f "delims=" %%A in ('powershell -Command "(curl -s -X POST http://localhost:8080/exports -H 'Content-Type: application/json' -d '{\"format\":\"json\",\"columns\":[{\"source\":\"id\",\"target\":\"id\"}]}') | ConvertFrom-Json | Select -ExpandProperty exportId"') do (
  set "jsonId=%%A"
)
echo JSON Export ID: !jsonId!

REM Download JSON
echo Downloading JSON export...
curl -s -X GET http://localhost:8080/exports/!jsonId!/download -o json_export.json
echo Downloaded to json_export.json

REM Create CSV export
for /f "delims=" %%A in ('powershell -Command "(curl -s -X POST http://localhost:8080/exports -H 'Content-Type: application/json' -d '{\"format\":\"csv\",\"columns\":[{\"source\":\"id\",\"target\":\"id\"}]}') | ConvertFrom-Json | Select -ExpandProperty exportId"') do (
  set "csvId=%%A"
)
echo CSV Export ID: !csvId!

REM Download CSV
echo Downloading CSV export...
curl -s -X GET http://localhost:8080/exports/!csvId!/download -o csv_export.csv
echo Downloaded to csv_export.csv

REM Create XML export
for /f "delims=" %%A in ('powershell -Command "(curl -s -X POST http://localhost:8080/exports -H 'Content-Type: application/json' -d '{\"format\":\"xml\",\"columns\":[{\"source\":\"id\",\"target\":\"id\"}]}') | ConvertFrom-Json | Select -ExpandProperty exportId"') do (
  set "xmlId=%%A"
)
echo XML Export ID: !xmlId!

REM Download XML
echo Downloading XML export...
curl -s -X GET http://localhost:8080/exports/!xmlId!/download -o xml_export.xml
echo Downloaded to xml_export.xml

REM Show file sizes
echo.
echo File sizes:
dir /B json_export.json csv_export.csv xml_export.xml 2>nul

echo.
echo First 20 lines of each:
echo --- JSON ---
powershell -Command "Get-Content json_export.json | Select-Object -First 20"
echo --- CSV ---
powershell -Command "Get-Content csv_export.csv | Select-Object -First 20"
echo --- XML ---
powershell -Command "Get-Content xml_export.xml | Select-Object -First 20"
