/**
 * Dev database helper: runs a portable embedded PostgreSQL (no Docker required)
 * for local verification when Docker Desktop is unavailable.
 *
 *   node scripts/dev-db.mjs start   — starts PG on port 5433 and keeps running
 *   node scripts/dev-db.mjs init     — initdb only (persistent)
 */
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 5433;
const USER = 'examguard';
const PASSWORD = 'examguard';
const DB = 'examguard';
const DATA_DIR = fileURLToPath(new URL('../.devdb', import.meta.url));

const command = process.argv[2] ?? 'start';

const pgServer = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

async function createDatabaseIfMissing() {
  const client = new pg.Client({ host: '127.0.0.1', port: PORT, user: USER, password: PASSWORD, database: 'postgres' });
  await client.connect();
  const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
  if (res.rowCount === 0) {
    await client.query(`CREATE DATABASE ${DB}`);
    console.log(`database '${DB}' created`);
  }
  await client.end();
}

if (command === 'init') {
  await pgServer.initialise();
  console.log('initialised', DATA_DIR);
} else {
  try {
    await pgServer.initialise();
  } catch {
    // already initialised (persistent)
  }
  await pgServer.start();
  await createDatabaseIfMissing();
  console.log(`embedded postgres ready on 127.0.0.1:${PORT} (db=${DB})`);
  console.log(`DATABASE_URL=postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB}?schema=public`);
  const stop = async () => {
    console.log('stopping embedded postgres…');
    await pgServer.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
