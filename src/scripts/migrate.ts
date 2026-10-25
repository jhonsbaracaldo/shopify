import 'dotenv/config';
import pg from 'pg';
import { MIGRATIONS_DIR } from '../composition.js';
import { runMigrations } from '../adapters/persistence/postgres/migrator.js';

/** `npm run db:migrate` — aplica las migraciones pendientes en DATABASE_URL. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Defina DATABASE_URL (ver .env.example)');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    const result = await runMigrations(pool, MIGRATIONS_DIR);
    console.log(
      `Migraciones aplicadas: ${result.applied.join(', ') || 'ninguna'}; ya aplicadas: ${result.alreadyApplied.length}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Error en migraciones:', error instanceof Error ? error.message : error);
  process.exit(1);
});
