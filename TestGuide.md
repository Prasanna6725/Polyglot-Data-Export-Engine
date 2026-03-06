# Polyglot Data Export Engine — Testing Guide

This guide provides **step-by-step instructions** to verify that the Data Export Engine works correctly.

All commands can be **copied and pasted directly into the terminal**.

---

# 🚀 1. Start the Application

Navigate to the project directory.

```bash
cd Polyglot-Data-Export-Engine

Stop any running containers and remove volumes.

docker-compose down -v

Start the system.

docker-compose up --build

Wait until the logs show:

Database connected
Server listening on port 8080

Open a new terminal window for the next steps.



🗄️ 2. Verify Database Seeding

Check that the database contains the dataset.

docker-compose exec db psql -U user -d exports_db -c "SELECT COUNT(*) FROM records;"

Expected result:
10000000

This confirms the database contains 10 million rows.


❤️ 3. Health Check

Verify that the API server is running.

curl http://localhost:8080/health

Expected response:
{"status":"ok"}


📄 4. Test CSV Export
Create Export Job

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"csv","columns":[{"source":"id","target":"ID"},{"source":"name","target":"Name"},{"source":"value","target":"Value"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download CSV
curl http://localhost:8080/exports/$export_id/download -o export.csv

Verify row count
wc -l export.csv

Expected result:
10000001
(10M rows + header)


🧾 5. Test JSON Export
Create Export

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"json","columns":[{"source":"id","target":"id"},{"source":"metadata","target":"metadata"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download JSON
curl http://localhost:8080/exports/$export_id/download -o export.json

Validate JSON
python -m json.tool export.json > /dev/null

If no error appears, the JSON is valid.


📑 6. Test XML Export
Create XML Export

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"xml","columns":[{"source":"id","target":"id"},{"source":"metadata","target":"metadata"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download XML
curl http://localhost:8080/exports/$export_id/download -o export.xml

Verify record count
grep -c "<record>" export.xml

Expected result:
10000000


📊 7. Test Parquet Export
Create Parquet Export

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"parquet","columns":[{"source":"id","target":"id"},{"source":"metadata","target":"metadata"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Download Parquet
curl http://localhost:8080/exports/$export_id/download -o export.parquet

Verify using Python
Start Python:

python

Then run:

import pyarrow.parquet as pq

table = pq.read_table("export.parquet")

print(table.num_rows)
print(table.column_names)

Expected output:
10000000
['id', 'metadata']

Exit Python:
exit()


🗜️ 8. Test Compression Support
Create Compressed CSV Export

export_id=$(curl -s -X POST http://localhost:8080/exports \
-H "Content-Type: application/json" \
-d '{"format":"csv","compression":"gzip","columns":[{"source":"id","target":"id"}]}' \
| sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')

echo $export_id

Check Response Headers
curl -I http://localhost:8080/exports/$export_id/download

Expected header:
Content-Encoding: gzip

Download Compressed File
curl http://localhost:8080/exports/$export_id/download -o export.csv.gz

Extract File
gunzip export.csv.gz

Verify Rows
wc -l export.csv

Expected result:
10000001


⚡ 9. Run Benchmark
curl http://localhost:8080/exports/benchmark

Example response:

{
 "datasetRowCount":10000000,
 "results":[
   {"format":"csv"},
   {"format":"json"},
   {"format":"xml"},
   {"format":"parquet"}
 ]
}


📈 10. Monitor Memory Usage
Monitor container memory usage while exports are running.

docker stats data_export_app

Expected memory usage:
< 256MB

This confirms that the engine uses streaming with constant memory usage.

🧹 Cleanup

Stop containers:
docker-compose down

Remove containers and volumes:
docker-compose down -v
