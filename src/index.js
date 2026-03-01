require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createWriter } = require('./writers-refactored');
const zlib = require('zlib');
const { ExportStore } = require('./exportStore');

const app = express();
const exportStore = new ExportStore();

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /exports - Create export job
app.post('/exports', async (req, res) => {
  try {
    const { format, columns, compression } = req.body;

    // Validation
    if (!format || !['csv', 'json', 'xml', 'parquet'].includes(format)) {
      return res.status(400).json({
        error: 'Invalid format. Must be one of: csv, json, xml, parquet',
      });
    }

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({
        error: 'Columns must be a non-empty array with source and target properties',
      });
    }

    // Validate columns
    for (const col of columns) {
      if (!col.source || !col.target) {
        return res.status(400).json({
          error: 'Each column must have source and target properties',
        });
      }
    }

    // Validate compression
    if (compression && !['gzip'].includes(compression)) {
      return res.status(400).json({
        error: 'Invalid compression. Must be gzip',
      });
    }

    const exportId = uuidv4();
    const exportJob = {
      exportId,
      format,
      columns,
      compression: compression || null,
      status: 'pending',
      createdAt: new Date(),
    };

    exportStore.set(exportId, exportJob);

    res.status(201).json({
      exportId,
      status: 'pending',
    });
  } catch (error) {
    console.error('Error creating export job:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /exports/{exportId}/download - Download export
app.get('/exports/:exportId/download', async (req, res) => {
  console.log('Download route entered for', req.params.exportId);

  let client;
  try {
    const { exportId } = req.params;
    const exportJob = exportStore.get(exportId);
    
    if (!exportJob) {
      console.log('Export job not found:', exportId);
      return res.status(404).json({ error: 'Export job not found' });
    }

    const format = exportJob.format;
    console.log('Export format:', format);

    // Validate format
    if (!['csv', 'json', 'xml', 'parquet'].includes(format)) {
      return res.status(400).json({ error: 'Unsupported format' });
    }

    // SET ALL HEADERS NOW (only once, at the start)
    const contentType = {
      csv: 'text/csv; charset=utf-8',
      json: 'application/json',
      xml: 'application/xml',
      parquet: 'application/octet-stream',
    }[format];

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="export.${format}"`);

    // Handle gzip compression (NOT for parquet)
    let output = res;
    const shouldCompress = exportJob.compression === 'gzip' && format !== 'parquet';
    if (shouldCompress) {
      res.setHeader('Content-Encoding', 'gzip');
      output = zlib.createGzip();
      output.pipe(res);
    }

    // Flush headers
    res.flushHeaders();
    console.log('Headers flushed');

    // Mark as in progress
    exportJob.status = 'in_progress';
    exportStore.set(exportId, exportJob);

    // Acquire database client
    client = await db.getClient();

    try {
      // PARQUET format uses special handling
      if (format === 'parquet') {
        const parquet = require('parquetjs');
        const fs = require('fs');
        const path = require('path');
        
        // Create schema
        const schemaObj = {};
        for (const col of exportJob.columns) {
          schemaObj[col.target] = { type: 'UTF8', optional: true };
        }
        const schema = new parquet.ParquetSchema(schemaObj);
        
        // Temp file for parquet output
        const tempFile = path.join('/tmp', `export_${exportId}_${Date.now()}.parquet`);
        
        // Start transaction and declare cursor
        await client.query('BEGIN');
        await client.query('DECLARE export_cursor CURSOR FOR SELECT id, name, value, metadata, created_at FROM records');
        
        // Create parquet writer
        const parquetWriter = await parquet.ParquetWriter.openFile(schema, tempFile);
        
        try {
          // Stream data from cursor
          const chunkSize = parseInt(process.env.EXPORT_CHUNK_SIZE) || 1000;
          let totalRows = 0;
          
          while (true) {
            const result = await client.query(`FETCH ${chunkSize} FROM export_cursor`);
            if (result.rows.length === 0) break;
            
            for (const row of result.rows) {
              const transformedRow = {};
              for (const col of exportJob.columns) {
                const value = row[col.source];
                transformedRow[col.target] = value === null || value === undefined ? null : 
                  (typeof value === 'object' ? JSON.stringify(value) : String(value));
              }
              await parquetWriter.appendRow(transformedRow);
              totalRows++;
            }
          }
          
          console.log('Exported', totalRows, 'rows to Parquet');
          
          // Close parquet writer
          await parquetWriter.close();
          
          // Stream file to response
          const fileStream = fs.createReadStream(tempFile);
          fileStream.pipe(output);
          
          await new Promise((resolve, reject) => {
            fileStream.on('end', resolve);
            fileStream.on('error', reject);
          });
          
          // Clean up temp file
          fs.unlink(tempFile, (err) => {
            if (err) console.error('Error deleting temp parquet file:', err);
          });
        } finally {
          await client.query('CLOSE export_cursor');
          await client.query('COMMIT');
        }
      } else {
        // CSV, JSON, XML formats
        const writer = createWriter(format, exportJob.columns);
        console.log('Writer created for format:', format);
        
        // Start transaction and declare cursor
        await client.query('BEGIN');
        await client.query('DECLARE export_cursor CURSOR FOR SELECT id, name, value, metadata, created_at FROM records');

        // Write header
        const header = writer.getHeader();
        if (header) {
          output.write(header);
        }

        // Stream data from cursor
        const chunkSize = parseInt(process.env.EXPORT_CHUNK_SIZE) || 1000;
        let totalRows = 0;

        while (true) {
          const result = await client.query(`FETCH ${chunkSize} FROM export_cursor`);
          if (result.rows.length === 0) break;

          for (const row of result.rows) {
            const serialized = writer.serializeRow(row);
            if (!output.write(serialized)) {
              // pause if write buffer is full
              await new Promise((resolve) => output.once('drain', resolve));
            }
            totalRows++;
          }
        }

        // Write footer
        const footer = writer.getFooter();
        if (footer) {
          output.write(footer);
        }

        console.log('Exported', totalRows, 'rows');

        // Close cursor and transaction
        await client.query('CLOSE export_cursor');
        await client.query('COMMIT');
      }

      // End the stream properly
      if (shouldCompress) {
        output.end();
      } else {
        res.end();
      }

      // Mark as completed
      exportJob.status = 'completed';
      exportStore.set(exportId, exportJob);
    } catch (err) {
      // Rollback on error
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Error rolling back:', rollbackErr.message);
      }
      throw err;
    }
  } catch (err) {
    console.error('Download error:', err.message);

    // Only send error response if headers haven't been sent
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Export failed', message: err.message });
    }

    // Headers already sent, destroy the connection
    try {
      res.destroy(err);
    } catch (_) {
      /* best effort */
    }
  } finally {
    if (client) {
      client.release();
    }
  }
});

// GET /exports/benchmark - Run performance benchmark
app.get('/exports/benchmark', async (req, res) => {
  try {
    const dimensions = { width: 100, height: 100 };
    const benchmarkResults = [];
    const formats = ['csv', 'json', 'xml', 'parquet'];
    const datasetRowCount = 10000000;

    for (const format of formats) {
      console.log(`Running benchmark for ${format}...`);

      const startTime = Date.now();
      const startMem = process.memoryUsage().heapUsed / 1024 / 1024;

      const columns = [
        { source: 'id', target: 'id' },
        { source: 'created_at', target: 'created_at' },
        { source: 'name', target: 'name' },
        { source: 'value', target: 'value' },
        { source: 'metadata', target: 'metadata' },
      ];

      // Create a mock response stream to measure output size
      const { PassThrough } = require('stream');
      const mockRes = new PassThrough();
      let contentLength = 0;

      mockRes.on('data', (chunk) => {
        contentLength += chunk.length;
      });

      try {
        let client = await db.getClient();

        try {
          await client.query('BEGIN');
          await client.query('DECLARE export_cursor CURSOR FOR SELECT id, name, value, metadata, created_at FROM records');

          const writer = createWriter(format, columns);

          const header = writer.getHeader();
          if (header) {
            mockRes.write(header);
          }

          let rowCount = 0;
          while (true) {
            const result = await client.query('FETCH 1000 FROM export_cursor');
            if (result.rows.length === 0) break;

            for (const row of result.rows) {
              const serialized = writer.serializeRow(row);
              if (!mockRes.write(serialized)) {
                await new Promise((r) => mockRes.once('drain', r));
              }
              rowCount++;
            }
          }

          const footer = writer.getFooter();
          if (footer) {
            mockRes.write(footer);
          }

          await client.query('CLOSE export_cursor');
          await client.query('COMMIT');

          console.log(`Exported ${rowCount} rows in benchmark`);
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        console.error(`Benchmark error for ${format}:`, err.message);
        continue;
      }

      const endTime = Date.now();
      const endMem = process.memoryUsage().heapUsed / 1024 / 1024;
      const peakMemory = Math.max(startMem, endMem);
      const duration = (endTime - startTime) / 1000;

      benchmarkResults.push({
        format,
        durationSeconds: Math.round(duration * 100) / 100,
        fileSizeBytes: contentLength,
        peakMemoryMB: Math.round(peakMemory * 100) / 100,
      });

      console.log(`Benchmark for ${format} completed: ${duration.toFixed(2)}s, ${contentLength} bytes`);

      if (global.gc) {
        global.gc();
      }
    }

    res.json({
      datasetRowCount,
      results: benchmarkResults,
    });
  } catch (error) {
    console.error('Error running benchmark:', error);
    res.status(500).json({ error: 'Benchmark failed' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Initialize database connection and start server
const PORT = process.env.PORT || 8080;

async function startServer() {
  try {
    // Test database connection
    await db.query('SELECT NOW()');
    console.log('✓ Database connected');

    app.listen(PORT, () => {
      console.log(`✓ Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
