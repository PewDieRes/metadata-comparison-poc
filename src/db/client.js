const { Pool } = require('pg');
const config = require('../config');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool(config.db);
    pool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL client:', err);
    });
  }
  return pool;
}

async function testConnection() {
  try {
    const client = await getPool().connect();
    const res = await client.query('SELECT NOW() as current_time, current_database() as db');
    client.release();
    return { success: true, timestamp: res.rows[0].current_time, database: res.rows[0].db };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  getPool,
  testConnection,
  query: (text, params) => getPool().query(text, params)
};
