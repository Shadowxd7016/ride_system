const mysql = require('mysql2/promise');
require('dotenv').config();

// Use Clever Cloud's default variable names to make deployment easier
const pool = mysql.createPool({
  host:               process.env.MYSQL_ADDON_HOST || process.env.DB_HOST,
  port:               parseInt(process.env.MYSQL_ADDON_PORT || process.env.DB_PORT) || 3306,
  user:               process.env.MYSQL_ADDON_USER || process.env.DB_USER,
  password:           process.env.MYSQL_ADDON_PASSWORD || process.env.DB_PASSWORD,
  database:           process.env.MYSQL_ADDON_DB || process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  // Clever Cloud requires SSL for external connections
  ssl: { 
    rejectUnauthorized: false 
  }
});

// Simple test to confirm connection on startup
pool.getConnection()
  .then(connection => {
    console.log('✅ Connected to Clever Cloud MySQL successfully!');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
  });

module.exports = pool;