import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase, migrateSqliteToPostgres, db } from './db.js';

try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../data/elms.sqlite');
  await initializeDatabase();
  const counts = await migrateSqliteToPostgres(sourcePath);
  console.log(`SQLite data copied from ${sourcePath} to the configured Postgres database:`);
  for (const [table, count] of Object.entries(counts)) console.log(`  ${table}: ${count}`);
  console.log('The source SQLite file was left unchanged.');
} catch (error) {
  console.error(`Migration stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
