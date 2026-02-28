#!/bin/bash

# Test CSV
echo "=== Testing CSV ==="
CSV_ID=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{"format":"csv","columns":[{"source":"id","target":"id"},{"source":"name","target":"name"},{"source":"value","target":"value"}]}' \
  | jq -r '.exportId')

echo "CSV Export ID: $CSV_ID"

# Get CSV and check Content-Type
CSV_RESP=$(curl -s -i http://localhost:8080/exports/$CSV_ID/download 2>&1)
echo "$CSV_RESP" | head -15 > /tmp/csv_headers.txt
echo "CSV Headers:"
cat /tmp/csv_headers.txt

echo ""
echo "=== Testing JSON ==="
JSON_ID=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{"format":"json","columns":[{"source":"id","target":"id"},{"source":"name","target":"name"},{"source":"value","target":"value"}]}' \
  | jq -r '.exportId')

echo "JSON Export ID: $JSON_ID"

# Get JSON response headers
curl -s -i http://localhost:8080/exports/$JSON_ID/download 2>&1 | head -10 > /tmp/json_headers.txt
echo "JSON Headers:"
cat /tmp/json_headers.txt

echo ""
echo "=== Testing XML ==="
XML_ID=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{"format":"xml","columns":[{"source":"id","target":"id"},{"source":"name","target":"name"},{"source":"value","target":"value"}]}' \
  | jq -r '.exportId')

echo "XML Export ID: $XML_ID"

# Get XML response headers
curl -s -i http://localhost:8080/exports/$XML_ID/download 2>&1 | head -10 > /tmp/xml_headers.txt
echo "XML Headers:"
cat /tmp/xml_headers.txt
