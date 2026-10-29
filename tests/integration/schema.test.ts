import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';

const database = `jungle_test_${randomUUID().replaceAll('-', '')}`;
let admin: MikroORM;
let orm: MikroORM;
const walletId = randomUUID();
const playerId = randomUUID();
const transactionId = randomUUID();
const ledgerId = randomUUID();

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(process.env.TEST_ADMIN_DATABASE_URL));
  await admin.em.getConnection().execute(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://jungle:jungle-local-only@localhost:55432/jungle');
  url.pathname = `/${database}`;
  orm = await MikroORM.init(databaseConfig(url.toString()));
  await orm.getMigrator().up();
});

afterAll(async () => {
  if (orm) await orm.close(true);
  if (admin) {
    // Only the randomly named test database created in this suite is removed.
    await admin.em.getConnection().execute(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.close(true);
  }
});

describe('PostgreSQL schema and migrations', () => {
  test('persists money as decimal text through the ORM', async () => {
    const em = orm.em.fork();
    const row = em.create('WalletRecord', { id: walletId, playerId, currency: 'BRL', balance: '100.00',
      version: 1, createdAt: new Date(), updatedAt: new Date() });
    await em.persistAndFlush(row);
    em.clear();
    const loaded = await em.findOneOrFail('WalletRecord', { id: walletId });
    expect(loaded).toHaveProperty('balance', '100.00');
  });

  test('database rejects negative balance and duplicate player/currency', async () => {
    const connection = orm.em.getConnection();
    await expect(connection.execute('UPDATE wallets SET balance = -1 WHERE id = ?', [walletId])).rejects.toThrow();
    await expect(connection.execute(`INSERT INTO wallets VALUES (?, ?, 'BRL', 0, 1, now(), now())`, [randomUUID(), playerId])).rejects.toThrow();
  });

  test('persists an opening transaction with an auditable ledger', async () => {
    await orm.em.fork().transactional(async em => {
      await em.execute(`INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,processed_at)
        VALUES (?, 'internal', ?, ?, ?, ?, ?, 'opening', 'internal', 'OPENING', 100, 'BRL', 'PROCESSED', now(), now())`,
      [transactionId, transactionId, transactionId, 'a'.repeat(64), walletId, playerId]);
      await em.execute(`INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', 100, 'BRL', 0, 100, now())`,
        [ledgerId, walletId, transactionId]);
    });
    const rows = await orm.em.getConnection().execute('SELECT sum(CASE WHEN direction = \'CREDIT\' THEN amount ELSE -amount END)::text AS balance FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
    expect(rows[0]?.balance).toBe('100.00');
  });

  test('ledger cannot be modified, deleted or truncated', async () => {
    const connection = orm.em.getConnection();
    await expect(connection.execute('UPDATE wallet_ledger_entries SET amount = 50 WHERE id = ?', [ledgerId])).rejects.toThrow();
    await expect(connection.execute('DELETE FROM wallet_ledger_entries WHERE id = ?', [ledgerId])).rejects.toThrow();
    await expect(connection.execute('TRUNCATE wallet_ledger_entries')).rejects.toThrow();
  });

  test('database rejects terminal transaction updates and duplicate ledger effects', async () => {
    const connection = orm.em.getConnection();
    await expect(connection.execute("UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?", [transactionId])).rejects.toThrow();
    await expect(connection.execute(`INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', 100, 'BRL', 0, 100, now())`,
      [randomUUID(), walletId, transactionId])).rejects.toThrow();
  });

  test('rolls back wallet and outbox together if the transaction fails', async () => {
    const eventId = randomUUID();
    await expect(orm.em.fork().transactional(async em => {
      await em.execute('UPDATE wallets SET balance = 90 WHERE id = ?', [walletId]);
      await em.execute(`INSERT INTO outbox_messages (id,aggregate_id,event_type,payload,occurred_at) VALUES (?, ?, 'Test', '{}', now())`, [eventId, walletId]);
      throw new Error('simulated failure before commit');
    })).rejects.toThrow();
    const connection = orm.em.getConnection();
    expect((await connection.execute('SELECT balance::text AS balance FROM wallets WHERE id = ?', [walletId]))[0]?.balance).toBe('100.00');
    expect(await connection.execute('SELECT id FROM outbox_messages WHERE id = ?', [eventId])).toHaveLength(0);
  });

  test('migration can be reversed and reapplied in the isolated test database', async () => {
    await orm.getMigrator().down();
    const connection = orm.em.getConnection();
    expect((await connection.execute("SELECT to_regclass('wallets') AS name"))[0]?.name).toBeNull();
    await orm.getMigrator().up();
    expect((await connection.execute("SELECT to_regclass('wallets') AS name"))[0]?.name).toBe('wallets');
  });
});
