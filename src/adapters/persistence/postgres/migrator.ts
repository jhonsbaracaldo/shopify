import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { sha256 } from '../../../domain/text.js';

const MIGRATION_LOCK_ID = 727_001;
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Migraciones SQL versionadas (`migrations/NNNN_nombre.sql`), aplicadas en orden y en transacción.
 * Un candado consultivo evita ejecuciones concurrentes. Si una migración ya aplicada cambió
 * (checksum distinto), se detiene: las migraciones son inmutables, se corrigen con una nueva.
 */
export async function runMigrations(pool: Pool, directory: string): Promise<MigrationResult> {
  const files = readdirSync(directory)
    .filter((f) => FILE_RE.test(f))
    .sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = readFileSync(join(directory, file), 'utf8');
      const checksum = sha256(sql.replace(/\r\n/g, '\n'));
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`La migración ${file} cambió después de aplicarse (checksum distinto)`);
        }
        result.alreadyApplied.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
