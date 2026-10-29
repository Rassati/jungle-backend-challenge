import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { createApp } from '../../src/http/app';
import type { TransactionResult } from '../../src/infrastructure/database/wagering-store';
import type { Queries } from '../../src/infrastructure/database/queries';

type WalletResponse = Awaited<ReturnType<Queries['wallet']>>;
type LedgerResponse = Awaited<ReturnType<Queries['ledger']>>;
type ReconciliationResponse = Awaited<ReturnType<Queries['reconciliation']>>;
async function json<T>(response: Response): Promise<T> { return await response.json() as T; }

const database = `jungle_test_${randomUUID().replaceAll('-', '')}`;
let admin: MikroORM;
let orm: MikroORM;
let server: Awaited<ReturnType<typeof createApp>>;
let url: string;
let walletId: string;
let transactionId: string;
const playerId = randomUUID();
const externalId = randomUUID();
const key = `provider:${externalId}`;
const body = () => ({ providerId: 'provider', externalTransactionId: externalId, playerId, walletId,
  roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
async function request(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(process.env.TEST_ADMIN_DATABASE_URL));
  await admin.em.getConnection().execute(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://jungle:jungle-local-only@localhost:55432/jungle');
  connection.pathname = `/${database}`;
  orm = await MikroORM.init(databaseConfig(connection.toString()));
  await orm.getMigrator().up();
  server = await createApp(orm);
  await server.app.listen(0, '127.0.0.1');
  url = await server.app.getUrl();
});
afterAll(async () => {
  if (server) { await server.app.close(); server.dispose(); }
  if (orm) await orm.close(true);
  if (admin) {
    await admin.em.getConnection().execute(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.close(true);
  }
});

describe('HTTP API with real PostgreSQL and LocalStack', () => {
  test('health endpoints are open and readiness checks both dependencies', async () => {
    expect((await request('/health/live')).status).toBe(200);
    const response = await request('/health/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', postgres: true, sqs: true });
  });

  test('invalid input is 400, creates wallet with 201 and duplicate wallet is 409', async () => {
    expect((await request('/wallets', 'POST', { playerId, initialBalance: { amount: 100, currency: 'BRL' } })).status).toBe(400);
    const input = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };
    const response = await request('/wallets', 'POST', input);
    expect(response.status).toBe(201);
    walletId = (await json<WalletResponse>(response)).id;
    expect((await request('/wallets', 'POST', input)).status).toBe(409);
    expect((await json<WalletResponse>(await request(`/wallets/${walletId}`))).balance.amount).toBe('100.00');
  });

  test('requires idempotency header and rejects unknown fields and OPENING', async () => {
    expect((await request('/wagering/transactions', 'POST', body())).status).toBe(400);
    expect((await request('/wagering/transactions', 'POST', { ...body(), kind: 'OPENING' }, { 'Idempotency-Key': key })).status).toBe(400);
    expect((await request('/wagering/transactions', 'POST', { ...body(), arbitrary: true }, { 'Idempotency-Key': key })).status).toBe(400);
  });

  test('successful bet and replay use 200; changed payload uses 409', async () => {
    const response = await request('/wagering/transactions', 'POST', body(), { 'Idempotency-Key': key, 'X-Correlation-Id': 'http-test' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe('http-test');
    const result = await json<TransactionResult>(response);
    transactionId = result.transactionId;
    expect(result.balance.amount).toBe('75.00');
    const replay = await request('/wagering/transactions', 'POST', body(), { 'Idempotency-Key': key });
    expect((await json<TransactionResult>(replay)).idempotentReplay).toBe(true);
    const conflict = await request('/wagering/transactions', 'POST', { ...body(), money: { amount: '30.00', currency: 'BRL' } }, { 'Idempotency-Key': key });
    expect(conflict.status).toBe(409);
  });

  test('transaction is queryable by internal and provider identifiers', async () => {
    const internal = await json<{ transactionId: string }>(await request(`/wagering/transactions/${transactionId}`));
    const external = await json<{ transactionId: string }>(await request(`/providers/provider/wagering/transactions/${externalId}`));
    expect(internal.transactionId).toBe(transactionId);
    expect(external).toEqual(internal);
  });

  test('business rejection is 422; waiting reference is 202', async () => {
    const rejected = await request('/wagering/transactions', 'POST', { ...body(), externalTransactionId: 'no-funds', money: { amount: '80.00', currency: 'BRL' } }, { 'Idempotency-Key': randomUUID() });
    expect(rejected.status).toBe(422);
    expect((await json<TransactionResult>(rejected)).failureCode).toBe('INSUFFICIENT_FUNDS');
    const pending = await request('/wagering/transactions', 'POST', { ...body(), kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'not-arrived' }, { 'Idempotency-Key': randomUUID() });
    expect(pending.status).toBe(202);
  });

  test('ledger cursor paginates without repetition and rejects invalid cursor/limits', async () => {
    const first = await json<LedgerResponse>(await request(`/wallets/${walletId}/ledger?limit=1`));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeString();
    const second = await json<LedgerResponse>(await request(`/wallets/${walletId}/ledger?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.nextCursor).toBeNull();
    expect((await request(`/wallets/${walletId}/ledger?cursor=invalid`)).status).toBe(400);
    expect((await request(`/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
  });

  test('reconciliation detects a divergence, emits a metric and never repairs silently', async () => {
    const before = await json<ReconciliationResponse>(await request(`/wallets/${walletId}/reconciliation`, 'POST'));
    expect(before.consistent).toBe(true);
    expect(before.calculatedBalance.amount).toBe('75.00');
    await orm.em.getConnection().execute('UPDATE wallets SET balance = 76 WHERE id = ?', [walletId]);
    const after = await json<ReconciliationResponse>(await request(`/wallets/${walletId}/reconciliation`, 'POST'));
    expect(after.consistent).toBe(false);
    expect(after.difference.amount).toBe('1.00');
    expect((await json<WalletResponse>(await request(`/wallets/${walletId}`))).balance.amount).toBe('76.00');
    expect(await (await request('/metrics')).text()).toContain('wallet_reconciliation_mismatches_total 1');
  });

  test('invalid UUID is 400; missing resource is 404', async () => {
    expect((await request('/wallets/not-a-uuid')).status).toBe(400);
    expect((await request(`/wallets/${randomUUID()}`)).status).toBe(404);
  });

  test('SQS outage gives readiness 503 while liveness remains 200', async () => {
    const unavailable = await createApp(orm, { sqsEndpoint: 'http://127.0.0.1:1' });
    try {
      await unavailable.app.listen(0, '127.0.0.1');
      const address = await unavailable.app.getUrl();
      expect((await fetch(`${address}/health/ready`)).status).toBe(503);
      expect((await fetch(`${address}/health/live`)).status).toBe(200);
    } finally { await unavailable.app.close(); unavailable.dispose(); }
  });

  test('database outage returns 503 without exposing queries or credentials', async () => {
    const disconnected = await MikroORM.init({ ...databaseConfig('postgresql://test:test@127.0.0.1:1/missing'), connect: false });
    const unavailable = await createApp(disconnected);
    try {
      await unavailable.app.listen(0, '127.0.0.1');
      const response = await fetch(`${await unavailable.app.getUrl()}/wallets/${randomUUID()}`);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.text()).not.toContain('postgresql');
    } finally { await unavailable.app.close(); unavailable.dispose(); await disconnected.close(true); }
  });
});
