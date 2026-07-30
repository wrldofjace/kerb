const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000, 
  connectionTimeoutMillis: 2000, 
});

pool.connect()
  .then(client => {
    console.log('PostgreSQL Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('Failed to connect to PostgreSQL', err);
  });

pool.on('error', (err) => {
  console.error('Unexpected database error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),

  getClient: async () => {
    const client = await pool.connect();
    const query = client.query;
    const release = client.release;
  
    const timeout = setTimeout(() => {
      console.error('A client has been checked out for more than 5 seconds!');
    }, 5000);

    client.release = () => {
      clearTimeout(timeout);
      client.query = query;
      client.release = release;
      return release.apply(client);
    };

    return client;
  },
  pool
};