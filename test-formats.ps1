# Test each export format

# Test CSV
Write-Host "Testing CSV export..."
$csvJob = curl -s -X POST http://localhost:8080/exports `
  -H 'Content-Type: application/json' `
  -d '{"format":"csv","columns":[{"source":"id","target":"id"},{"source":"name","target":"name"},{"source":"value","target":"value"}]}'

$csvExportId = ($csvJob | ConvertFrom-Json).exportId
Write-Host "CSV Export ID: $csvExportId"

$csvDl = curl -s -i http://localhost:8080/exports/$csvExportId/download
$csvLines = $csvDl -split "`n" | Select-Object -First 5
Write-Host "CSV Response (first 5 lines):"
$csvLines | ForEach-Object { Write-Host $_ }
Write-Host ""

# Test JSON
Write-Host "Testing JSON export..."
$jsonJob = curl -s -X POST http://localhost:8080/exports `
  -H 'Content-Type: application/json' `
  -d '{"format":"json","columns":[{"source":"id","target":"id"},{"source":"name","target":"name"},{"source":"value","target":"value"}]}'

$jsonExportId = ($jsonJob | ConvertFrom-Json).exportId
Write-Host "JSON Export ID: $jsonExportId"

$jsonDl = curl -s -i http://localhost:8080/exports/$jsonExportId/download
$jsonLines = $jsonDl -split "`n" | Select-Object -First 5
Write-Host "JSON Response (first 5 lines):"
$jsonLines | ForEach-Object { Write-Host $_ }
Write-Host ""

# Test XML
Write-Host "Testing XML export..."
$xmlJob = curl -s -X POST http://localhost:8080/exports `
  -H 'Content-Type: application/json' `
  -d '{"format":"xml","columns":[{"source":"id","target":"id"},{"source":"name","target":"name"},{"source":"value","target":"value"}]}'

$xmlExportId = ($xmlJob | ConvertFrom-Json).exportId
Write-Host "XML Export ID: $xmlExportId"

$xmlDl = curl -s -i http://localhost:8080/exports/$xmlExportId/download
$xmlLines = $xmlDl -split "`n" | Select-Object -First 5
Write-Host "XML Response (first 5 lines):"
$xmlLines | ForEach-Object { Write-Host $_ }
