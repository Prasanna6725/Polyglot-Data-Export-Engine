#!/bin/bash
set -e

echo "Waiting for database to be ready..."
# target row count may be overridden in environment by TOTAL_ROWS
TARGET_ROWS=${TOTAL_ROWS:-10000000}

max_attempts=60
attempt=0

while [[ $attempt -lt $max_attempts ]]; do
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT COUNT(*) FROM records" > /dev/null 2>&1; then
        row_count=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT COUNT(*) FROM records" -t | tr -d ' ')
        
        if [[ "$row_count" == "$TARGET_ROWS" ]]; then
            echo "✓ Database ready with $TARGET_ROWS rows"
            break
        else
            echo "Database has $row_count rows, waiting for seeding completion..."
        fi
    else
        echo "Waiting for database connection..."
    fi
    
    attempt=$((attempt + 1))
    if [[ $((attempt % 15)) -eq 0 ]]; then
        echo "Still waiting... ($attempt/$max_attempts attempts)"
    fi
    sleep 2
done

if [[ $attempt -eq $max_attempts ]]; then
    echo "✗ Database did not become ready in time"
    exit 1
fi

echo "✓ Starting application..."
exec npm start
