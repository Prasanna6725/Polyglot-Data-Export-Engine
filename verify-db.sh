#!/bin/bash

# Database verification script
# Checks that the database is properly seeded with 10 million rows

POSTGRES_DB="exports_db"
POSTGRES_USER="user"
POSTGRES_HOST="db"
POSTGRES_PORT="5432"

echo "=========================================="
echo "Database Verification Script"
echo "=========================================="
echo "Database: $POSTGRES_DB"
echo "User: $POSTGRES_USER"
echo "Host: $POSTGRES_HOST:$POSTGRES_PORT"
echo ""

# Wait for database to be ready
echo "[1] Waiting for database to be ready..."
max_attempts=30
attempt=0

while [[ $attempt -lt $max_attempts ]]; do
    if PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1" > /dev/null 2>&1; then
        echo "✓ Database is ready"
        break
    fi
    attempt=$((attempt + 1))
    echo "  Attempt $attempt/$max_attempts..."
    sleep 2
done

if [[ $attempt -eq $max_attempts ]]; then
    echo "✗ Database did not become ready"
    exit 1
fi

echo ""
echo "[2] Checking table structure..."
table_check=$(PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='records'" -t)

if [[ $table_check -eq 1 ]]; then
    echo "✓ Table 'records' exists"
else
    echo "✗ Table 'records' does not exist"
    exit 1
fi

echo ""
echo "[3] Checking table schema..."
PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" << 'EOF' 
\d records
EOF

echo ""
echo "[4] Counting rows..."
row_count=$(PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT COUNT(*) FROM records" -t | tr -d ' ')

echo "✓ Total rows: $row_count"

if [[ "$row_count" == "10000000" ]]; then
    echo "✓ Correct row count (10,000,000)"
else
    echo "⚠ Expected 10,000,000 rows but found $row_count"
fi

echo ""
echo "[5] Checking data sample..."
PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "SELECT id, name, value, created_at, metadata FROM records LIMIT 3" 

echo ""
echo "[6] Checking indexes..."
PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" << 'EOF'
SELECT indexname FROM pg_indexes WHERE tablename = 'records';
EOF

echo ""
echo "[7] Checking metadata JSONB structure..."
PGPASSWORD="password" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "SELECT metadata FROM records LIMIT 1" -c "SELECT jsonb_pretty(metadata) FROM records LIMIT 1"

echo ""
echo "=========================================="
echo "Database verification complete!"
echo "=========================================="
