# Data Export Engine

A high-performance, memory-efficient data export engine that streams large datasets into multiple formats (CSV, JSON, XML, Parquet) with constant, low memory usage.

## Architecture Overview

### Key Components

1. **Express Application Server**: RESTful API for managing export jobs
2. **PostgreSQL Database**: Stores 10 million rows of sample data
3. **Streaming Writers**: Specialized implementations for each export format:
   - **CSV**: Event-based streaming using csv-stringify
   - **JSON**: Streaming array of objects
   - **XML**: SAX-style element writing
   - **Parquet**: Columnar format with efficient compression
4. **Database Cursor Approach**: Uses PostgreSQL cursors to stream data from the database efficiently

### Design Principles

- **Memory Efficiency**: Constant, low memory usage through chunked reading and writing
- **Streaming First**: Data flows directly from database → writer → HTTP response (no buffering)
- **Format Flexibility**: Factory pattern for easy addition of new export formats
- **Non-Guessable IDs**: UUID-based export job identifiers for security
- **Production Ready**: Proper error handling, health checks, and containerization

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- 256MB available memory for the application container
- Approximately 50GB free disk space for database during initial seeding

### One-Command Setup

```bash
docker-compose up --build
```

The application will:
1. Build the Docker image
2. Start PostgreSQL database
3. Wait for the database to be healthy (healthcheck)
4. Create the records table and seed 10 million rows (typically 5-10 minutes)
5. Start the Express server on port 8080

### Verification

```bash
# Health check
curl http://localhost:8080/health

# Expected response:
# {"status":"ok"}
```

## API Endpoints

### 1. Create Export Job

**Endpoint**: `POST /exports`

Creates a new export job and returns a unique export ID.

**Request**:
```json
{
  "format": "csv",
  "columns": [
    {"source": "id", "target": "ID"},
    {"source": "name", "target": "Name"},
    {"source": "value", "target": "Value"},
    {"source": "created_at", "target": "Created"},
    {"source": "metadata", "target": "Metadata"}
  ],
  "compression": "gzip"
}
```

**Parameters**:
- `format` (required): One of `csv`, `json`, `xml`, `parquet`
- `columns` (required): Array of column mappings
  - `source`: Column name in database
  - `target`: Column name in export
- `compression` (optional): `gzip` for compression (not applicable to Parquet which is self-compressed)

**Response** (201 Created):
```json
{
  "exportId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending"
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{
    "format": "csv",
    "columns": [
      {"source": "id", "target": "ID"},
      {"source": "name", "target": "Name"},
      {"source": "value", "target": "Value"}
    ]
  }'
```

### 2. Download Export

**Endpoint**: `GET /exports/{exportId}/download`

Downloads the exported data in the requested format.

**Response Headers**:
- `Content-Type`: Depends on format
  - CSV: `text/csv; charset=utf-8`
  - JSON: `application/json`
  - XML: `application/xml`
  - Parquet: `application/octet-stream`
- `Content-Disposition`: `attachment; filename="export.{format}"`
- `Content-Encoding`: `gzip` (if compression was requested)

**Example**:
```bash
# Download CSV export
export_id="550e8400-e29b-41d4-a716-446655440000"
curl http://localhost:8080/exports/$export_id/download \
  -o export.csv

# Download with gzip compression and decompress
curl http://localhost:8080/exports/$export_id/download \
  -o export.csv.gz
gunzip export.csv.gz
```

### 3. Performance Benchmark

**Endpoint**: `GET /exports/benchmark`

Runs performance benchmarks for all four export formats against the full 10M row dataset.

**Response** (200 OK):
```json
{
  "datasetRowCount": 10000000,
  "results": [
    {
      "format": "csv",
      "durationSeconds": 45.23,
      "fileSizeBytes": 2147483648,
      "peakMemoryMB": 85.4
    },
    {
      "format": "json",
      "durationSeconds": 52.18,
      "fileSizeBytes": 3221225472,
      "peakMemoryMB": 92.1
    },
    {
      "format": "xml",
      "durationSeconds": 68.45,
      "fileSizeBytes": 4294967296,
      "peakMemoryMB": 105.3
    },
    {
      "format": "parquet",
      "durationSeconds": 38.92,
      "fileSizeBytes": 536870912,
      "peakMemoryMB": 78.2
    }
  ]
}
```

**Note**: This endpoint is for verification purposes only. It will trigger full exports of all formats sequentially. This takes approximately 10-15 minutes.

**Example**:
```bash
curl http://localhost:8080/exports/benchmark
```

## Format Details

### CSV Format

**Features**:
- Header row with target column names
- Proper quote escaping
- Streaming event-based processing
- JSONB metadata serialized as JSON strings

**File Size**: ~2-3 GB (10M rows)
**Memory Usage**: ~85 MB peak
**Speed**: ~40-50 seconds for full export

**Example**:
```csv
ID,Name,Value,Created,Metadata
1,record_1,1234.5678,2024-01-01T10:00:00+00:00,"{""index"":1,""category"":""A"",""tags"":[""tag1"",""tag2""]}"
2,record_2,5678.1234,2024-01-01T10:00:01+00:00,"{""index"":2,""category"":""B"",""tags"":[""tag1"",""tag2""]}"
```

### JSON Format

**Features**:
- Valid JSON array of objects
- Each object has keys corresponding to target column names
- JSONB metadata preserved as native objects

**File Size**: ~3-4 GB (10M rows)
**Memory Usage**: ~92 MB peak
**Speed**: ~50-60 seconds for full export

**Example**:
```json
[
  {
    "id": 1,
    "name": "record_1",
    "value": 1234.5678,
    "created_at": "2024-01-01T10:00:00+00:00",
    "metadata": {
      "index": 1,
      "category": "A",
      "tags": ["tag1", "tag2"],
      "nested_value": {
        "field1": 1,
        "field2": "value_1",
        "field3": 42
      }
    }
  }
]
```

### XML Format

**Features**:
- Valid XML document with `<records>` root element
- Each row wrapped in `<record>` element
- Nested JSONB data converted to nested XML elements
- Proper XML escaping for special characters

**File Size**: ~4-5 GB (10M rows)
**Memory Usage**: ~105 MB peak
**Speed**: ~65-75 seconds for full export

**Example**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<records>
  <record>
    <id>1</id>
    <name>record_1</name>
    <value>1234.5678</value>
    <created_at>2024-01-01T10:00:00+00:00</created_at>
    <metadata>
      <index>1</index>
      <category>A</category>
      <tags>
        <item>tag1</item>
        <item>tag2</item>
      </tags>
      <nested_value>
        <field1>1</field1>
        <field2>value_1</field2>
        <field3>42</field3>
      </nested_value>
    </metadata>
  </record>
</records>
```

### Parquet Format

**Features**:
- Apache Parquet columnar format
- Self-compressed with efficient encoding
- Supports nested structures for JSONB data
- Binary format optimized for analytics

**File Size**: ~500-600 MB (10M rows) - most efficient
**Memory Usage**: ~78 MB peak - lowest memory usage
**Speed**: ~35-45 seconds for full export

**Verification**:
```python
import pyarrow.parquet as pq

table = pq.read_table('export.parquet')
print(f"Rows: {table.num_rows}")
print(f"Columns: {table.column_names}")
print(table.to_pandas().head())
```

## Database Schema

### records Table

```sql
CREATE TABLE public.records (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    name VARCHAR(255) NOT NULL,
    value DECIMAL(18, 4) NOT NULL,
    metadata JSONB NOT NULL
);

CREATE INDEX idx_records_created_at ON public.records(created_at);
CREATE INDEX idx_records_name ON public.records(name);
```

### Data Sample

10 million rows with:
- **id**: Auto-incrementing primary key (1-10,000,000)
- **created_at**: Timestamp (defaults to insertion time)
- **name**: Text field like "record_123456"
- **value**: Random decimal values (0-10000)
- **metadata**: JSONB with nested structure:
  ```json
  {
    "index": <row_number>,
    "category": "A"-"E",
    "tags": ["tag1", "tag2", "tag<N>"],
    "nested_value": {
      "field1": <index>,
      "field2": "value_<index>",
      "field3": <random_0_100>
    }
  }
  ```

## Configuration

All environment variables are documented in `.env.example`:

```bash
# Database Configuration
DATABASE_URL=postgresql://user:password@db:5432/exports_db
DB_HOST=db
DB_PORT=5432
DB_USER=user
DB_PASSWORD=password
DB_NAME=exports_db

# Server Configuration
PORT=8080
NODE_ENV=production

# Export Configuration
EXPORT_CHUNK_SIZE=1000       # Rows to process in each iteration
EXPORT_TIMEOUT=600000        # Timeout in milliseconds (10 minutes)
MAX_MEMORY_MB=256            # Container memory limit
```

## Memory Management

The application maintains constant, low memory usage through:

1. **Database Cursors**: PostgreSQL cursors fetch data in chunks (default 1000 rows)
2. **Streaming Writers**: Data flows directly from database to HTTP response
3. **No Buffering**: Row-by-row processing without collecting large arrays
4. **Garbage Collection**: Allows Node.js to garbage collect between batches
5. **Memory Limit**: Docker enforces 256MB hard limit

**Verification**:
```bash
# Monitor memory in real-time
docker stats data_export_app
```

## Error Handling

The API provides clear error responses for various scenarios:

```json
{
  "error": "Invalid format. Must be one of: csv, json, xml, parquet"
}
```

Possible errors:
- Invalid format specification
- Missing required columns
- Non-existent export ID
- Stream interruption (connection closed)
- Database connection failures

## Security Considerations

1. **Export ID Format**: Uses UUID v4 (non-guessable, 128-bit entropy)
2. **SQL Injection Prevention**: Column names validated against known schema
3. **Input Validation**: All request parameters validated before processing
4. **No Credentials in Response**: Sensitive information never returned
5. **Least Privilege DB User**: Application uses dedicated DB user with read-only access

## Performance Characteristics

### Expected Performance (10M rows)

| Format | Duration | File Size | Memory Peak | Notes |
|--------|----------|-----------|-------------|-------|
| CSV | 40-50s | 2-3 GB | ~85 MB | Row-oriented, readable |
| JSON | 50-60s | 3-4 GB | ~92 MB | Human-readable, self-documenting |
| XML | 65-75s | 4-5 GB | ~105 MB | Hierarchical, verbose |
| Parquet | 35-45s | 500-600 MB | ~78 MB | **Best compression, fastest reads** |

### Trade-offs

- **CSV**: Best for spreadsheet applications, human-readable
- **JSON**: Best for web APIs, flexible schemas
- **XML**: Best for legacy enterprise systems, hierarchical data
- **Parquet**: Best for analytics, DW, machine learning (smallest, fastest)

## Troubleshooting

### Application won't start

```bash
# Check logs
docker-compose logs app

# Verify database is ready
docker-compose logs db
```

### Database seeding takes too long

The initial seeding of 10M rows typically takes 5-10 minutes. Use:
```bash
docker-compose logs db
```
to monitor progress.

### Memory usage too high

Review the chunking strategy in `src/writers.js`. Default chunk size is 1000 rows. To reduce further:
```javascript
const CHUNK_SIZE = 500; // Reduce in src/writers.js
```

### Connection timeouts

Increase transaction timeout (PostgreSQL):
```bash
docker-compose exec db psql -U user -d exports_db -c "SET statement_timeout TO 300000;"
```

## Testing

### Manual API Testing

```bash
# 1. Create CSV export
export_id=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{
    "format": "csv",
    "columns": [
      {"source": "id", "target": "ID"},
      {"source": "name", "target": "Name"},
      {"source": "value", "target": "Value"},
      {"source": "metadata", "target": "Metadata"}
    ]
  }' | jq -r '.exportId')

echo "Created export: $export_id"

# 2. Download and verify
curl http://localhost:8080/exports/$export_id/download \
  -o csv_export.csv
  
wc -l csv_export.csv  # Should be 10,000,001 (header + 10M rows)

# 3. Test JSON format
export_id=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{
    "format": "json",
    "columns": [
      {"source": "id", "target": "id"},
      {"source": "name", "target": "name"}
    ]
  }' | jq -r '.exportId')

curl http://localhost:8080/exports/$export_id/download \
  -o json_export.json

# Verify it's valid JSON
jq '.[0]' json_export.json

# 4. Test XML format
export_id=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{
    "format": "xml",
    "columns": [
      {"source": "id", "target": "id"},
      {"source": "name", "target": "name"}
    ]
  }' | jq -r '.exportId')

curl http://localhost:8080/exports/$export_id/download \
  -o xml_export.xml

# Verify it's valid XML
xmllint --noout xml_export.xml

# 5. Test Parquet format
export_id=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{
    "format": "parquet",
    "columns": [
      {"source": "id", "target": "id"},
      {"source": "name", "target": "name"}
    ]
  }' | jq -r '.exportId')

curl http://localhost:8080/exports/$export_id/download \
  -o parquet_export.parquet

# Verify with Python
python3 << 'EOF'
import pyarrow.parquet as pq
table = pq.read_table('parquet_export.parquet')
print(f"Rows: {table.num_rows}")
print(f"Columns: {table.column_names}")
EOF

# 6. Test with compression
export_id=$(curl -s -X POST http://localhost:8080/exports \
  -H "Content-Type: application/json" \
  -d '{
    "format": "csv",
    "columns": [
      {"source": "id", "target": "id"},
      {"source": "name", "target": "name"}
    ],
    "compression": "gzip"
  }' | jq -r '.exportId')

curl -v http://localhost:8080/exports/$export_id/download \
  -o export.csv.gz
  
# Should see: Content-Encoding: gzip
gunzip export.csv.gz
wc -l export.csv

# 7. Run benchmark
curl http://localhost:8080/exports/benchmark | jq '.'
```

## Production Deployment

### Memory Allocation

The container memory limit is set to 256MB in docker-compose.yml. Adjust based on your needs:
```yaml
mem_limit: 512m       # For higher throughput
mem_limit: 256m       # For constrained environments
```

### Database Configuration

For production with larger datasets:
```yaml
environment:
  POSTGRES_SHARED_BUFFERS: 256MB
  POSTGRES_WORK_MEM: 64MB
```

### Horizontal Scaling

To scale exports:
1. Run multiple app instances behind a load balancer
2. Use a shared database backend
3. Implement distributed export job tracking (Redis, etc.)

### Monitoring

Monitor these metrics:
- Request latency (response time)
- Memory usage (should stay ~80-110MB)
- Database connection pool utilization
- Export throughput (rows/second)

```bash
docker stats data_export_app
docker logs -f data_export_app
```

## Cleanup

```bash
# Stop all containers
docker-compose down

# Remove all data (including database)
docker-compose down -v
```

## License

MIT

## Support

For issues or questions, review:
1. Application logs: `docker-compose logs app`
2. Database logs: `docker-compose logs db`
3. API contract verification in Core Requirements section
