const { Transform, PassThrough } = require('stream');
const { stringify } = require('csv-stringify');
const db = require('./db');

const CHUNK_SIZE = parseInt(process.env.EXPORT_CHUNK_SIZE) || 1000;

// Base class for streaming writers
class StreamingWriter extends Transform {
  constructor(exportJob) {
    super();
    this.exportJob = exportJob;
    this.columns = exportJob.columns;
    this.rowCount = 0;
  }

  async streamFromDatabase() {
    console.log('streamFromDatabase start');
    let client;
    let transactionActive = false;
    let cursorOpen = false;

    try {
      client = await db.getClient();
      console.log('Got DB client');

      // Add error handler to prevent unhandled client errors
      const clientErrorHandler = (err) => {
        console.error('Client error during export:', err.message, err.code);
        this.emit('error', err);
      };
      client.on('error', clientErrorHandler);

      // Use cursor for efficient streaming
      console.log('Beginning transaction');
      await client.query('BEGIN');
      transactionActive = true;

      // Build the SELECT clause with column mapping
      const selectCols = this.columns.map((c) => `"${c.source}"`).join(', ');
      const query = `SELECT ${selectCols} FROM public.records ORDER BY id`;

      console.log('Declaring cursor');
      // Create a cursor
      await client.query(`DECLARE export_cursor CURSOR FOR ${query}`);
      cursorOpen = true;

      let hasMore = true;
      while (hasMore) {
        console.log('Fetching next chunk');
        const result = await client.query(`FETCH ${CHUNK_SIZE} FROM export_cursor`);

        if (result.rows.length === 0) {
          hasMore = false;
          console.log('No more rows');
          break;
        }

        for (const row of result.rows) {
          await this.writeRow(row);
          this.rowCount++;
        }

        // Allow event loop to process
        await new Promise((resolve) => setImmediate(resolve));
      }

      console.log('Finished reading cursor, finalizing stream');
      // Finalize before closing cursor
      await this.finalize();

      // Safe cursor close
      if (cursorOpen) {
        try {
          await client.query('CLOSE export_cursor');
        } catch (closeErr) {
          console.error('Error closing cursor:', closeErr.message);
        }
        cursorOpen = false;
      }

      // Safe commit
      if (transactionActive) {
        try {
          await client.query('COMMIT');
        } catch (commitErr) {
          console.error('Error committing transaction:', commitErr.message);
        }
        transactionActive = false;
      }
    } catch (error) {
      console.error('Export streaming error:', error.message, error.code);

      // Safe cleanup on error
      if (client && transactionActive) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Error rolling back transaction:', rollbackErr.message);
        }
      }

      // Emit error to stream handler
      this.emit('error', error);
    } finally {
      // Ensure cursor is closed
      if (client && cursorOpen) {
        try {
          await client.query('CLOSE export_cursor');
        } catch (err) {
          console.error('Error closing cursor in finally:', err.message);
        }
      }

      // Ensure transaction is closed
      if (client && transactionActive) {
        try {
          await client.query('ROLLBACK');
        } catch (err) {
          console.error('Error rolling back in finally:', err.message);
        }
      }

      // Release client back to pool
      if (client) {
        client.release();
        console.log('Released DB client');
      }
    }
  }

  async writeRow(row) {
    // Override in subclasses
  }

  async finalize() {
    this.push(null);
  }

  _transform(chunk, encoding, callback) {
    callback();
  }

  _final(callback) {
    this.streamFromDatabase().catch((error) => {
      this.emit('error', error);
      callback(error);
    });
  }
}

// CSV Writer
class CSVWriter extends StreamingWriter {
  constructor(exportJob) {
    super(exportJob);
    this.csvStringifier = stringify({
      header: true,
      columns: this.columns.map((c) => ({ key: c.source, header: c.target })),
    });
  }

  async writeRow(row) {
    const transformedRow = this.transformRowColumns(row);
    return new Promise((resolve, reject) => {
      this.csvStringifier.write(transformedRow, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  transformRowColumns(row) {
    const result = {};
    for (const col of this.columns) {
      let value = row[col.source];

      // Handle JSONB metadata
      if (col.source === 'metadata' && typeof value === 'object') {
        value = JSON.stringify(value);
      }

      result[col.source] = value;
    }
    return result;
  }

  async finalize() {
    return new Promise((resolve, reject) => {
      this.csvStringifier.finish();
      this.csvStringifier.on('error', reject);
      this.csvStringifier.on('data', (chunk) => {
        this.push(chunk);
      });
      this.csvStringifier.on('end', () => {
        this.push(null);
        resolve();
      });
    });
  }
}

// JSON Writer
class JSONWriter extends StreamingWriter {
  constructor(exportJob) {
    super(exportJob);
    this.firstRow = true;
    this.push('[');
  }

  transformRowColumns(row) {
    const result = {};
    for (const col of this.columns) {
      result[col.target] = row[col.source];
    }
    return result;
  }

  async writeRow(row) {
    const transformedRow = this.transformRowColumns(row);

    if (!this.firstRow) {
      this.push(',');
    }
    this.firstRow = false;

    this.push(JSON.stringify(transformedRow));
  }

  async finalize() {
    this.push(']');
    this.push(null);
  }
}

// XML Writer
class XMLWriter_Stream extends StreamingWriter {
  constructor(exportJob) {
    super(exportJob);
    this.push('<?xml version="1.0" encoding="UTF-8"?>\n<records>\n');
  }

  transformRowColumns(row) {
    const result = {};
    for (const col of this.columns) {
      result[col.target] = row[col.source];
    }
    return result;
  }

  async writeRow(row) {
    const transformedRow = this.transformRowColumns(row);
    let xml = '  <record>\n';

    for (const [key, value] of Object.entries(transformedRow)) {
      if (typeof value === 'object' && value !== null) {
        xml += this.objectToXml(key, value, 3);
      } else {
        const escapedValue = this.escapeXml(String(value || ''));
        xml += `    <${key}>${escapedValue}</${key}>\n`;
      }
    }

    xml += '  </record>\n';
    this.push(xml);
  }

  objectToXml(key, obj, indent) {
    let xml = `${' '.repeat(indent)}<${key}>\n`;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === 'object') {
          xml += `${' '.repeat(indent + 2)}<item>\n`;
          for (const [k, v] of Object.entries(item)) {
            const escapedValue = this.escapeXml(String(v || ''));
            xml += `${' '.repeat(indent + 4)}<${k}>${escapedValue}</${k}>\n`;
          }
          xml += `${' '.repeat(indent + 2)}</item>\n`;
        } else {
          const escapedValue = this.escapeXml(String(item || ''));
          xml += `${' '.repeat(indent + 2)}<item>${escapedValue}</item>\n`;
        }
      }
    } else {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'object') {
          xml += this.objectToXml(k, v, indent + 2);
        } else {
          const escapedValue = this.escapeXml(String(v || ''));
          xml += `${' '.repeat(indent + 2)}<${k}>${escapedValue}</${k}>\n`;
        }
      }
    }

    xml += `${' '.repeat(indent)}</${key}>\n`;
    return xml;
  }

  escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  async finalize() {
    this.push('</records>');
    this.push(null);
  }
}

// Parquet Writer - Efficient buffering approach
class ParquetWriterOptimized extends StreamingWriter {
  constructor(exportJob) {
    super(exportJob);
    this.buffer = [];
    this.bufferSize = 50000;
    this.tempFile = null;
    this.parquetWriter = null;
  }

  transformRowColumns(row) {
    const result = {};
    for (const col of this.columns) {
      const value = row[col.source];
      // Convert to string for safety with parquet
      if (typeof value === 'object' && value !== null) {
        result[col.target] = JSON.stringify(value);
      } else if (value === null || value === undefined) {
        result[col.target] = '';
      } else {
        result[col.target] = String(value);
      }
    }
    return result;
  }

  async writeRow(row) {
    const transformedRow = this.transformRowColumns(row);
    this.buffer.push(transformedRow);

    if (this.buffer.length >= this.bufferSize) {
      await this.flushBuffer();
    }
  }

  async flushBuffer() {
    if (this.buffer.length === 0) return;

    try {
      const parquet = require('parquetjs');
      const fs = require('fs');
      const path = require('path');
      const os = require('os');

      // Create temp file on first flush
      if (!this.tempFile) {
        this.tempFile = path.join(os.tmpdir(), `parquet_${Date.now()}_${Math.random().toString(36).slice(2)}.parquet`);
        
        // Create schema
        const firstRow = this.buffer[0];
        const schemaObj = {};
        
        for (const col of this.columns) {
          schemaObj[col.target] = { type: 'UTF8', optional: true };
        }

        const schema = new parquet.ParquetSchema(schemaObj);
        this.parquetWriter = parquet.ParquetWriter.openFile(schema, this.tempFile);
      }

      // Write buffered rows
      for (const row of this.buffer) {
        await this.parquetWriter.appendRow(row);
      }

      this.buffer = [];
    } catch (error) {
      console.error('Error flushing parquet buffer:', error);
      throw error;
    }
  }

  async finalize() {
    // Flush any remaining rows
    if (this.buffer.length > 0) {
      await this.flushBuffer();
    }

    // Close writer and stream file
    if (this.parquetWriter) {
      await this.parquetWriter.close();

      const fs = require('fs');
      const readStream = fs.createReadStream(this.tempFile);
      
      readStream.on('data', (chunk) => {
        this.push(chunk);
      });

      await new Promise((resolve, reject) => {
        readStream.on('end', () => {
          // Clean up temp file
          fs.unlink(this.tempFile, (err) => {
            if (err) console.error('Error deleting temp file:', err);
          });
          this.push(null);
          resolve();
        });
        readStream.on('error', reject);
      });
    } else {
      this.push(null);
    }
  }
}

// Factory function to create the appropriate writer
function createExportWriter(exportJob, res) {
  const format = exportJob.format;
  let writer;

  switch (format) {
    case 'csv':
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      writer = new CSVWriter(exportJob);
      break;
    case 'json':
      res.setHeader('Content-Type', 'application/json');
      writer = new JSONWriter(exportJob);
      break;
    case 'xml':
      res.setHeader('Content-Type', 'application/xml');
      writer = new XMLWriter_Stream(exportJob);
      break;
    case 'parquet':
      res.setHeader('Content-Type', 'application/octet-stream');
      writer = new ParquetWriterOptimized(exportJob);
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  // Start streaming immediately
  writer.streamFromDatabase().catch((error) => {
    writer.emit('error', error);
  });

  return writer;
}

module.exports = { createExportWriter, CSVWriter, JSONWriter, XMLWriter_Stream, ParquetWriterOptimized };
