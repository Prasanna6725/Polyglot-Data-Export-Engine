#!/bin/bash
set -e

echo "Starting database initialization..."

# Create the records table
# determine desired row count from environment (shell variable)
total_rows_env=${TOTAL_ROWS:-10000000}

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Drop existing table if it exists (for idempotency)
    DROP TABLE IF EXISTS records CASCADE;

    -- Create the records table
    CREATE TABLE public.records (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        name VARCHAR(255) NOT NULL,
        value DECIMAL(18, 4) NOT NULL,
        metadata JSONB NOT NULL
    );

    -- Create indexes for better query performance
    CREATE INDEX idx_records_created_at ON public.records(created_at);
    CREATE INDEX idx_records_name ON public.records(name);

    -- Seed data using a procedural approach
    -- This approach is efficient and handles large datasets well

    DO \$\$
    DECLARE
        batch_size INT := 10000;
        total_rows INT := ${total_rows_env};
        i INT := 0;
        start_time TIMESTAMP;
    BEGIN
        start_time := CLOCK_TIMESTAMP();
        RAISE NOTICE 'Starting data seeding. Target: % rows, Batch size: %', total_rows, batch_size;
        
        -- Insert data in batches
        WHILE i < total_rows LOOP
            INSERT INTO public.records (name, value, metadata)
            SELECT
                'record_' || (i + seq) AS name,
                (RANDOM() * 10000)::DECIMAL(18, 4) AS value,
                jsonb_build_object(
                    'index', i + seq,
                    'category', CASE (i + seq) % 5 WHEN 0 THEN 'A' WHEN 1 THEN 'B' WHEN 2 THEN 'C' WHEN 3 THEN 'D' ELSE 'E' END,
                    'tags', jsonb_build_array('tag1', 'tag2', 'tag' || ((i + seq) % 100)),
                    'nested_value', jsonb_build_object(
                        'field1', (i + seq),
                        'field2', 'value_' || (i + seq),
                        'field3', (RANDOM() * 100)::INT
                    )
                ) AS metadata
            FROM generate_series(1, LEAST(batch_size, total_rows - i)) AS seq;
            
            i := i + batch_size;
            
            -- Progress report every 100k rows
            IF i % 100000 = 0 THEN
                RAISE NOTICE 'Inserted % rows. Elapsed: %', i, CLOCK_TIMESTAMP() - start_time;
            END IF;
        END LOOP;
        
        RAISE NOTICE 'Data seeding completed. Total rows: %. Elapsed: %', total_rows, CLOCK_TIMESTAMP() - start_time;
    END
    \$\$;

    -- Verify the count
    SELECT COUNT(*) as total_records FROM public.records;

EOSQL

echo "Database initialization completed successfully!"
