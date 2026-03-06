Testing Guide

This section provides step-by-step instructions to verify that the Data Export Engine is working correctly. All commands can be copied and executed directly in a terminal.

1. Start the Application

Navigate to the project directory:

cd Polyglot-Data-Export-Engine

Stop any existing containers and remove old volumes:

docker-compose down -v

Start the system:

docker-compose up --build

Wait until the logs show:

Database connected
Server listening on port 8080

Open a new terminal for the following tests.

2. Verify Database Seeding

Check that the database contains the required dataset.

docker-compose exec db psql -U user -d exports_db -c "SELECT COUNT(*) FROM records;"

Expected result:

10000000

This confirms the database was seeded with 10 million rows.

3. Health Check

Verify that the API server is running.

curl http://localhost:8080/health

Expected response:

{"status":"ok"}
4. Test CSV Export

Create a CSV export job:

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"csv","columns":[{"source":"id","target":"ID"},{"source":"name","target":"Name"},{"source":"value","target":"Value"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download the CSV file:

curl http://localhost:8080/exports/$export_id/download -o export.csv

Verify the number of rows:

wc -l export.csv

Expected result:

10000001

(10,000,000 records + header row)

5. Test JSON Export

Create a JSON export job:

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"json","columns":[{"source":"id","target":"id"},{"source":"metadata","target":"metadata"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download the JSON file:

curl http://localhost:8080/exports/$export_id/download -o export.json

Validate JSON structure:

python -m json.tool export.json > /dev/null

If no error appears, the JSON file is valid.

6. Test XML Export

Create an XML export job:

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"xml","columns":[{"source":"id","target":"id"},{"source":"metadata","target":"metadata"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download the XML file:

curl http://localhost:8080/exports/$export_id/download -o export.xml

Count XML records:

grep -c "<record>" export.xml

Expected result:

10000000
7. Test Parquet Export

Create a Parquet export job:

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"parquet","columns":[{"source":"id","target":"id"},{"source":"metadata","target":"metadata"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download the Parquet file:

curl http://localhost:8080/exports/$export_id/download -o export.parquet

Verify the file using Python:

python

Inside Python:

import pyarrow.parquet as pq
table = pq.read_table("export.parquet")
print(table.num_rows)
print(table.column_names)

Expected output:

10000000
['id', 'metadata']

Exit Python:

exit()
8. Test Compression Support

Create a compressed CSV export:

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"csv","compression":"gzip","columns":[{"source":"id","target":"id"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Check response headers:

*curl -I http://localhost:8080/exports/$export_id/download*

Expected header:

Content-Encoding: gzip

Download compressed file:

*curl http://localhost:8080/exports/$export_id/download -o export.csv.gz*

Extract the file:

*gunzip export.csv.gz*

Verify rows:

*wc -l export.csv*

Expected result:

10000001
9. Run Performance Benchmark

Execute the benchmark endpoint:

*curl http://localhost:8080/exports/benchmark*

Example response:

{
 "datasetRowCount":10000000,
 "results":[
  {"format":"csv","durationSeconds":...},
  {"format":"json","durationSeconds":...},
  {"format":"xml","durationSeconds":...},
  {"format":"parquet","durationSeconds":...}
 ]
}
10. Monitor Memory Usage

While exports are running, monitor container memory usage:

*docker stats data_export_app*

Expected memory usage should remain under:

256MB

This confirms that the export system uses streaming and maintains constant memory usage.

Cleanup

To stop all services:

docker-compose down

To remove containers and database data:

docker-compose down -v