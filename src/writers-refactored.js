/**
 * Writer implementations for different export formats.
 * 
 * Each writer is responsible for formatting a single row of data.
 * Writers are NOT responsible for:
 *  - Setting HTTP headers
 *  - Managing database connections
 *  - Handling streaming (res.pipe, res.write)
 * 
 * Writers ARE responsible for:
 *  - Initializing format-specific state (headers for CSV, opening brackets for JSON, etc)
 *  - Serializing individual rows
 *  - Finalizing format-specific state (closing brackets, XML root tags, etc)
 */

const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');

/**
 * Base writer class with common functionality.
 * Subclasses implement format-specific logic.
 */
class BaseWriter {
  constructor(columns) {
    this.columns = columns;
    this.isFirstRow = true;
  }

  /**
   * Get header content for the format.
   * Subclasses override to return format-specific header.
   */
  getHeader() {
    return '';
  }

  /**
   * Serialize a single row of data.
   * Subclasses override this to handle their format.
   */
  serializeRow(row) {
    throw new Error('serializeRow must be implemented by subclass');
  }

  /**
   * Get footer content for the format.
   * Subclasses override to return format-specific footer.
   */
  getFooter() {
    return '';
  }

  /**
   * Helper to safely encode a value as a string.
   */
  encodeValue(value) {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }
}

/**
 * CSV Writer - outputs CSV format with header row.
 */
class CSVWriter extends BaseWriter {
  constructor(columns) {
    super(columns);
  }

  getHeader() {
    // CSV header row with column target names
    return this.columns.map(c => c.target).join(',') + '\n';
  }

  serializeRow(row) {
    return this.columns
      .map(col => {
        const value = this.encodeValue(row[col.source]);
        // escape quotes and wrap in quotes if needed
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
          return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      })
      .join(',') + '\n';
  }
}

/**
 * JSON Writer - outputs valid JSON array.
 */
class JSONWriter extends BaseWriter {
  constructor(columns) {
    super(columns);
  }

  getHeader() {
    return '[';
  }

  serializeRow(row) {
    const obj = {};
    for (const col of this.columns) {
      obj[col.target] = row[col.source];
    }

    const json = JSON.stringify(obj);
    
    // add comma before all rows except first
    if (this.isFirstRow) {
      this.isFirstRow = false;
      return json;
    }
    return ',' + json;
  }

  getFooter() {
    return ']';
  }
}

/**
 * XML Writer - outputs valid XML document.
 */
class XMLWriter extends BaseWriter {
  constructor(columns) {
    super(columns);
  }

  getHeader() {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<records>\n';
  }

  serializeRow(row) {
    let xml = '  <record>\n';

    for (const col of this.columns) {
      const value = row[col.source];
      const tagName = col.target;

      if (typeof value === 'object' && value !== null) {
        // nested JSONB becomes nested XML
        xml += this.objectToXml(tagName, value, 4);
      } else {
        const escapedValue = this.escapeXml(this.encodeValue(value));
        xml += `    <${tagName}>${escapedValue}</${tagName}>\n`;
      }
    }

    xml += '  </record>\n';
    return xml;
  }

  /**
   * Convert a nested object/array to XML elements.
   */
  objectToXml(key, obj, indent) {
    const indentStr = ' '.repeat(indent);
    let xml = `${indentStr}<${key}>\n`;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === 'object' && item !== null) {
          xml += `${indentStr}  <item>\n`;
          for (const [k, v] of Object.entries(item)) {
            const escapedValue = this.escapeXml(this.encodeValue(v));
            xml += `${indentStr}    <${k}>${escapedValue}</${k}>\n`;
          }
          xml += `${indentStr}  </item>\n`;
        } else {
          const escapedValue = this.escapeXml(this.encodeValue(item));
          xml += `${indentStr}  <item>${escapedValue}</item>\n`;
        }
      }
    } else if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'object' && v !== null) {
          xml += this.objectToXml(k, v, indent + 2);
        } else {
          const escapedValue = this.escapeXml(this.encodeValue(v));
          xml += `${indentStr}  <${k}>${escapedValue}</${k}>\n`;
        }
      }
    }

    xml += `${indentStr}</${key}>\n`;
    return xml;
  }

  /**
   * Escape XML special characters.
   */
  escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  getFooter() {
    return '</records>';
  }
}

/**
 * Parquet Writer - writes Apache Parquet format using parquetjs.
 * This writer handles the database streaming internally.
 */
class ParquetWriter extends Transform {
  constructor(columns) {
    super();
    this.columns = columns;
    this.buffer = [];
    this.bufferSize = 10000; // batch size
    this.schema = null;
    this.started = false;
  }

  /**
   * Transform a row for Parquet (all values as strings or null).
   */
  transformRow(row) {
    const result = {};
    for (const col of this.columns) {
      const value = row[col.source];
      if (value === null || value === undefined) {
        result[col.target] = null;
      } else if (typeof value === 'object') {
        result[col.target] = JSON.stringify(value);
      } else {
        result[col.target] = String(value);
      }
    }
    return result;
  }

  /**
   * Write a row to the buffer.
   * When buffer fills, flush to Parquet file.
   */
  async writeRow(row) {
    this.buffer.push(this.transformRow(row));
    if (this.buffer.length >= this.bufferSize) {
      await this.flushBuffer();
    }
  }

  /**
   * Flush buffered rows to Parquet.
   */
  async flushBuffer() {
    if (this.buffer.length === 0) return;

    const parquet = require('parquetjs');

    // create schema on first flush
    if (!this.schema) {
      const schemaObj = {};
      for (const col of this.columns) {
        schemaObj[col.target] = { type: 'UTF8', optional: true };
      }
      this.schema = new parquet.ParquetSchema(schemaObj);
    }

    // write rows to a temp memory buffer
    const writer = await parquet.ParquetWriter.openFile(this.schema, '/tmp/temp_parquet_' + Date.now());

    try {
      for (const row of this.buffer) {
        await writer.appendRow(row);
      }
    } finally {
      await writer.close();
    }

    // stream the file to output
    const fs = require('fs');
    const filePath = writer.fs.path;
    
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => {
        this.push(chunk);
      });
      stream.on('end', () => {
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting temp parquet file:', err);
        });
        resolve();
      });
      stream.on('error', reject);
    });
  }

  /**
   * Finalize by flushing remaining rows and ending stream.
   */
  async finalize() {
    await this.flushBuffer();
    this.push(null);
  }
}

/**
 * Factory function to create the appropriate writer for a format.
 */
function createWriter(format, columns) {
  switch (format) {
    case 'csv':
      return new CSVWriter(columns);
    case 'json':
      return new JSONWriter(columns);
    case 'xml':
      return new XMLWriter(columns);
    case 'parquet':
      return new ParquetWriter(columns);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

module.exports = {
  createWriter,
  BaseWriter,
  CSVWriter,
  JSONWriter,
  XMLWriter,
  ParquetWriter,
};
