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
    this.schema = null;      // schema created on first flush
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

    const parquet = require('parquetjs');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    // build schema once
    if (!this.schema) {
      const schemaObj = {};
      for (const col of this.columns) {
        schemaObj[col.target] = { type: 'UTF8', optional: true };
      }
      this.schema = new parquet.ParquetSchema(schemaObj);
    }

    // write current buffer to a temporary chunk file
    const chunkFile = path.join(os.tmpdir(), `parquet_chunk_${Date.now()}_${Math.random().toString(36).slice(2)}.parquet`);
    const writer = await parquet.ParquetWriter.openFile(this.schema, chunkFile);

    try {
      for (const row of this.buffer) {
        await writer.appendRow(row);
      }
    } finally {
      await writer.close();
    }

    // stream the chunk immediately, then delete it
    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(chunkFile);
      readStream.on('data', (chunk) => {
        this.push(chunk);
      });
      readStream.on('end', () => {
        fs.unlink(chunkFile, (err) => {
          if (err) console.error('Error deleting chunk file:', err);
        });
        resolve();
      });
      readStream.on('error', reject);
    });

    // release buffer memory
    this.buffer = [];
  }

  async finalize() {
    // Flush any remaining rows
    if (this.buffer.length > 0) {
      await this.flushBuffer();
    }

    // signal end of stream
    this.push(null);
  }
}

// Factory function to create the appropriate writer
// NOTE: headers are the caller's responsibility; do NOT touch the response here.
// The returned writer is a readable stream which should be piped to the response
// by the caller (e.g. `writer.pipe(res)`).
function createExportWriter(exportJob) {
  const format = exportJob.format;
  let writer;

  switch (format) {
    case 'csv':
      writer = new CSVWriter(exportJob);
      break;
    case 'json':
      writer = new JSONWriter(exportJob);
      break;
    case 'xml':
      writer = new XMLWriter_Stream(exportJob);
      break;
    case 'parquet':
      writer = new ParquetWriterOptimized(exportJob);
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  // Start the database streaming process immediately; errors will be emitted on
  // the writer stream itself so the caller can handle them.
  writer.streamFromDatabase().catch((error) => {
    writer.emit('error', error);
  });

  return writer;
}

module.exports = { createExportWriter, CSVWriter, JSONWriter, XMLWriter_Stream, ParquetWriterOptimized };
