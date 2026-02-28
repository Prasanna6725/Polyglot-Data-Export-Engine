const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Handle pool errors without crashing the process
pool.on('error', (err) => {
  console.error('Pool error (idle client):', err.message, err.code);
  // Do NOT exit - let connections be cleaned up naturally
  // Subsequent queries will fail if the pool is exhausted, which is handled by route error handlers
});

// Handle connection errors
pool.on('connect', (client) => {
  // Add error handler to prevent unhandled errors on client
  client.on('error', (err) => {
    console.error('Client error:', err.message, err.code);
    // Error is logged; client will be removed from pool
  });
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
