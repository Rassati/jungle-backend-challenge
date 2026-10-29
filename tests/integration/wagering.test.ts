import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { WageringStore } from '../../src/infrastructure/database/wagering-store';
import type { WagerPayload } from '../../src/application/payload-hash';

const database = `jungle_test_${randomUUID().replaceAll('-', '')}`;
let admin: MikroORM;
let orm: MikroORM;
let store: WageringStore;
let databaseUrl: string;
beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(process.env.TEST_ADMIN_DATABASE_URL));
  await admin.em.getConnection().execute(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://jungle:jungle-local-only@localhost:55432/jungle');
  url.pathname = `/${database}`;
  databaseUrl = url.toString();
  orm = await MikroORM.init(databaseConfig(databaseUrl));
  await orm.getMigrator().up();
  store = new WageringStore(orm);
});
afterAll(async () => {
  if (orm) await orm.close(true);
  if (admin) {
    await admin.em.getConnection().execute(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.close(true);
  }
});

async function scenario(amount = '100.00') {
  const playerId = randomUUID();
  const wallet = await store.openWallet(playerId, { amount, currency: 'BRL' });
  const payload: WagerPayload = { providerId: 'provider-a', playerId, walletId: wallet.id,
    externalTransactionId: randomUUID(), roundId: randomUUID(), gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  return { wallet, payload, key: randomUUID() };
}
const submit = (payload: WagerPayload, key: string) => store.submit(payload, key, { correlationId: key });
async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toHaveProperty('code', code);
}
async function assertReconciled(walletId: string, expected: string) {
  const rows = await orm.em.getConnection().execute(`SELECT w.balance::text AS stored,
    COALESCE(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS calculated
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = ? GROUP BY w.id`, [walletId]);
  expect(rows[0]).toEqual({ stored: expected, calculated: expected });
}

describe('Atomic wagering use case against PostgreSQL', () => {
  test('opening wallet includes OPENING and ledger, zero opening does not', async () => {
    const { wallet } = await scenario();
    await assertReconciled(wallet.id, '100.00');
    const zero = await scenario('0.00');
    await assertReconciled(zero.wallet.id, '0.00');
    expect(await orm.em.getConnection().execute('SELECT id FROM wager_transactions WHERE wallet_id = ?', [zero.wallet.id])).toHaveLength(0);
    let conflict: unknown;
    try { await store.openWallet(wallet.playerId, wallet.balance); }
    catch (error) { conflict = error; }
    expect(conflict).toHaveProperty('code', 'WALLET_CONFLICT');
  });

  test('50 concurrent identical requests debit only once and return the original response', async () => {
    const { wallet, payload, key } = await scenario();
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(payload, key)));
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every(result => result.balance.amount === '75.00')).toBe(true);
    await assertReconciled(wallet.id, '75.00');
    expect(await orm.em.getConnection().execute("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [wallet.id])).toHaveLength(1);
  });

  test('two simultaneous 80.00 bets compete for 100.00 without negative balance', async () => {
    const { wallet, payload, key } = await scenario();
    payload.money.amount = '80.00';
    const results = await Promise.all([submit(payload, key), submit({ ...payload, externalTransactionId: randomUUID() }, randomUUID())]);
    expect(results.filter(result => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter(result => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    await assertReconciled(wallet.id, '20.00');
  });

  test('replay preserves historical balance after later transactions; payload conflict is rejected', async () => {
    const { wallet, payload, key } = await scenario();
    await submit(payload, key);
    await submit({ ...payload, externalTransactionId: randomUUID() }, randomUUID());
    const replay = await submit(payload, key);
    expect(replay.balance.amount).toBe('75.00');
    expect(replay.idempotentReplay).toBe(true);
    await assertReconciled(wallet.id, '50.00');
    await expectCode(submit({ ...payload, money: { amount: '26.00', currency: 'BRL' } }, key), 'IDEMPOTENCY_CONFLICT');
    await expectCode(submit(payload, randomUUID()), 'IDEMPOTENCY_CONFLICT');
  });

  test('concurrent reversals of the same type only credit once', async () => {
    const { wallet, payload, key } = await scenario();
    await submit(payload, key);
    const refund: WagerPayload = { ...payload, kind: 'REFUND', referenceExternalTransactionId: payload.externalTransactionId, externalTransactionId: randomUUID() };
    const results = await Promise.all([submit(refund, randomUUID()), submit({ ...refund, externalTransactionId: randomUUID() }, randomUUID())]);
    expect(results.filter(result => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter(result => result.failureCode === 'ALREADY_REVERSED')).toHaveLength(1);
    await assertReconciled(wallet.id, '100.00');
  });

  test('missing reference remains pending without altering the balance', async () => {
    const { wallet, payload } = await scenario();
    const result = await submit({ ...payload, kind: 'REFUND', referenceExternalTransactionId: 'not-arrived' }, randomUUID());
    expect(result.status).toBe('PENDING_REFERENCE');
    await assertReconciled(wallet.id, '100.00');
  });

  test('different wallets process concurrently and LOSS produces no balance event', async () => {
    const scenarios = await Promise.all(Array.from({ length: 4 }, () => scenario()));
    const results = await Promise.all(scenarios.map(item => submit(item.payload, item.key)));
    expect(results.every(result => result.status === 'PROCESSED')).toBe(true);
    for (const item of scenarios) await assertReconciled(item.wallet.id, '75.00');
    const item = scenarios[0]!;
    await submit({ ...item.payload, kind: 'LOSS', externalTransactionId: randomUUID(), money: { amount: '0.00', currency: 'BRL' } }, randomUUID());
    expect(await orm.em.getConnection().execute("SELECT id FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'", [item.wallet.id])).toHaveLength(2);
    await assertReconciled(item.wallet.id, '75.00');
  });

  test('inbox redelivery is persistent and does not duplicate financial effects or events', async () => {
    const { wallet, payload, key } = await scenario();
    const context = { correlationId: key, inbox: { consumerName: 'test-consumer', messageId: randomUUID() } };
    await store.submit(payload, key, context);
    expect((await store.submit(payload, key, context)).idempotentReplay).toBe(true);
    expect(await orm.em.getConnection().execute('SELECT id FROM outbox_messages WHERE aggregate_id = ?', [wallet.id])).toHaveLength(3);
    const rows = await orm.em.getConnection().execute('SELECT processed_at FROM inbox_messages WHERE message_id = ?', [context.inbox.messageId]);
    expect(Number.isNaN(new Date(rows[0]?.processed_at).getTime())).toBe(false);
    await assertReconciled(wallet.id, '75.00');
  });

  test('failure writing outbox rolls back wallet, transaction, ledger and inbox', async () => {
    const { wallet, payload, key } = await scenario();
    const connection = orm.em.getConnection();
    await connection.execute(`CREATE FUNCTION simulate_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'WagerTransactionProcessed' THEN RAISE EXCEPTION 'simulated outbox failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION simulate_outbox_failure();`);
    const context = { correlationId: key, inbox: { consumerName: 'failure', messageId: randomUUID() } };
    try {
      let failure: unknown;
      try { await store.submit(payload, key, context); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      await assertReconciled(wallet.id, '100.00');
      expect(await connection.execute('SELECT id FROM wager_transactions WHERE idempotency_key = ?', [key])).toHaveLength(0);
      expect(await connection.execute('SELECT message_id FROM inbox_messages WHERE message_id = ?', [context.inbox.messageId])).toHaveLength(0);
      expect(await connection.execute('SELECT id FROM outbox_messages WHERE aggregate_id = ?', [wallet.id])).toHaveLength(1);
    } finally {
      await connection.execute('DROP TRIGGER fail_outbox ON outbox_messages; DROP FUNCTION simulate_outbox_failure();');
    }
  });

  test('three independent Bun processes cannot spend the same balance twice', async () => {
    const { wallet, payload } = await scenario();
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath,
      resolve('tests/fixtures/submit-process.ts'), JSON.stringify({ payload: { ...payload, money: { amount: '80.00', currency: 'BRL' }, externalTransactionId: randomUUID() }, key: randomUUID() })],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => {
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect(await child.exited, errors).toBe(0);
      return JSON.parse(output);
    }));
    expect(results.filter(result => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter(result => result.status === 'REJECTED')).toHaveLength(2);
    await assertReconciled(wallet.id, '20.00');
  });
});
