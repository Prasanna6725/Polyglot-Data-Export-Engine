require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createExportWriter } = require('./writers');
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
  console.log('Download route entered');

  let client;
  try {
    const { exportId } = req.params;
    console.log('Looking up export job', exportId);
    const exportJob = exportStore.get(exportId);
    console.log('Export job retrieved:', exportJob ? exportJob.exportId : null);
    if (!exportJob) {
      console.log('Export job not found, returning 404');
      return res.status(404).json({ error: 'Export job not found' });
    }
    console.log('Export format is', exportJob.format);

    exportJob.status = 'in_progress';
    exportStore.set(exportId, exportJob);

    // choose headers based on format
    switch (exportJob.format) {
      case 'csv':
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        break;
      case 'json':
        res.setHeader('Content-Type', 'application/json');
        break;
      case 'xml':
        res.setHeader('Content-Type', 'application/xml');
        break;
      case 'parquet':
        res.setHeader('Content-Type', 'application/octet-stream');
        break;
      default:
        return res.status(400).json({ error: 'Unsupported format' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="export.${exportJob.format}"`);
    res.flushHeaders();

    console.log('Headers sent, acquiring client');
    client = await db.getClient();

    console.log('BEGIN');
    await client.query('BEGIN');
    console.log('DECLARE cursor');
    await client.query('DECLARE export_cursor CURSOR FOR SELECT id, name, value FROM records');

    // streaming logic per format
    if (exportJob.format === 'parquet') {
      // delegate to Parquet writer
      const writer = createExportWriter(exportJob, res);
      // writer is a readable stream; commit/close inside loop
      while (true) {
        console.log('Loop fetch');
        const result = await client.query('FETCH 1000 FROM export_cursor');
        if (result.rows.length === 0) break;
        for (const row of result.rows) {
          await writer.writeRow(row);
        }
      }
      console.log('Closing and commit');
      await client.query('CLOSE export_cursor');
      await client.query('COMMIT');
      await writer.finalize();
      res.end();
      return;
    }

    // non-parquet formats
    let firstJson = true;
    if (exportJob.format === 'csv') {
      res.write('ID,Name,Value\n');
    } else if (exportJob.format === 'json') {
      res.write('[');
    } else if (exportJob.format === 'xml') {
      res.write('<?xml version="1.0" encoding="UTF-8"?>\n<records>\n');
    }

    while (true) {
      console.log('Loop fetch');
      const result = await client.query('FETCH 1000 FROM export_cursor');
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        if (exportJob.format === 'csv') {
          const line = `${row.id},${row.name},${row.value}\n`;
          if (!res.write(line)) {
            await new Promise((r) => res.once('drain', r));
          }
        } else if (exportJob.format === 'json') {
          const json = JSON.stringify(row);
          if (!firstJson) {
            if (!res.write(',')) {
              await new Promise((r) => res.once('drain', r));
            }
          }
          if (!res.write(json)) {
            await new Promise((r) => res.once('drain', r));
          }
          firstJson = false;
        } else if (exportJob.format === 'xml') {
          const xml =
            `  <record><id>${row.id}</id><name>${row.name}</name><value>${row.value}</value></record>\n`;
          if (!res.write(xml)) {
            await new Promise((r) => res.once('drain', r));
          }
        }
      }
    }

    if (exportJob.format === 'json') {
      res.write(']');
    } else if (exportJob.format === 'xml') {
      res.write('</records>');
    }

    console.log('Closing and commit');
    await client.query('CLOSE export_cursor');
    await client.query('COMMIT');
    console.log('Ending response');
    res.end();
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Export failed' });
    }
    if (client) client.release();
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

      // Create a temporary export job
      const exportId = uuidv4();
      const exportJob = {
        exportId,
        format,
        columns: [
          { source: 'id', target: 'id' },
          { source: 'created_at', target: 'created_at' },
          { source: 'name', target: 'name' },
          { source: 'value', target: 'value' },
          { source: 'metadata', target: 'metadata' },
        ],
        compression: null,
        status: 'benchmarking',
      };

      // Create a mock response stream
      const { PassThrough } = require('stream');
      const mockRes = new PassThrough();
      let contentLength = 0;

      mockRes.on('data', (chunk) => {
        contentLength += chunk.length;
      });

      const writer = createExportWriter(exportJob, mockRes);
      writer.pipe(mockRes);

      // Wait for stream to complete
      await new Promise((resolve, reject) => {
        mockRes.on('finish', resolve);
        mockRes.on('error', reject);
        writer.on('error', reject);
      });

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

      // Force garbage collection if available
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
