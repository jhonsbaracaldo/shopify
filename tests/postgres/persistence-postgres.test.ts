import { afterAll, beforeAll, describe, it } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../src/adapters/persistence/postgres/migrator.js';
import { PostgresPersistence } from '../../src/adapters/persistence/postgres/postgres-persistence.js';
import { MIGRATIONS_DIR } from '../../src/composition.js';
import { persistenceContract } from '../contract/persistence-contract.js';

/**
 * Pruebas contra PostgreSQL REAL. Requieren TEST_DATABASE_URL (base dedicada, se vacía en cada prueba):
 *   TEST_DATABASE_URL=postgres://dropship:<password>@127.0.0.1:5433/dropship_test npm run test:postgres
 * Sin la variable se omiten (se informa como "skipped").
 */
const url = process.env.TEST_DATABASE_URL;

if (!url) {
  describe.skip('Persistence contract — PostgreSQL (defina TEST_DATABASE_URL)', () => {
    it('omitido', () => undefined);
  });
} else {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const persistence = new PostgresPersistence(pool);

  beforeAll(async () => {
    await runMigrations(pool, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  persistenceContract('PostgreSQL', async () => {
    await pool.query(
      'TRUNCATE idempotency_keys, store_publications, approvals, evaluations, product_sync_history, product_variants, products, sync_runs, suppliers RESTART IDENTITY CASCADE',
    );
    return persistence;
  });
}
