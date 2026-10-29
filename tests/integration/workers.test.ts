import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand, DeleteQueueCommand, DeleteMessageCommand,
  ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { WageringStore } from '../../src/infrastructure/database/wagering-store';
import { Queries } from '../../src/infrastructure/database/queries';
import { createSqs } from '../../src/infrastructure/messaging/sqs';
import { OutboxPublisher, QueueConsumer, ReferenceWorker } from '../../src/infrastructure/messaging/workers';
import { Telemetry } from '../../src/observability';

const suffix = randomUUID().replaceAll('-', '');
const database = `jungle_test_${suffix}`;
let admin: MikroORM, orm: MikroORM, store: WageringStore, sqs: SQSClient;
let inputUrl: string, dlqUrl: string, eventsUrl: string, databaseUrl: string;
const telemetry = new Telemetry();
let consumer: QueueConsumer, publisher: OutboxPublisher;
beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(process.env.TEST_ADMIN_DATABASE_URL));
  await admin.em.getConnection().execute(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://jungle:jungle-local-only@localhost:55432/jungle');
  url.pathname = `/${database}`; databaseUrl = url.toString();
  orm = await MikroORM.init(databaseConfig(databaseUrl)); await orm.getMigrator().up();
  store = new WageringStore(orm, telemetry); sqs = createSqs();
  const urls = await Promise.all(['input','dlq','events'].map(async name => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: `test-${suffix}-${name}.fifo`, Attributes: { FifoQueue: 'true' } }));
    return queue.QueueUrl!;
  }));
  inputUrl = urls[0]!; dlqUrl = urls[1]!; eventsUrl = urls[2]!;
  consumer = new QueueConsumer(sqs, inputUrl, dlqUrl, store, telemetry, { waitSeconds: 0, maxAttempts: 2 });
  publisher = new OutboxPublisher(orm, sqs, eventsUrl, telemetry);
});
afterAll(async () => {
  if (sqs) {
    await Promise.all([inputUrl, dlqUrl, eventsUrl].filter(Boolean).map(QueueUrl => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
    sqs.destroy();
  }
  if (orm) await orm.close(true);
  if (admin) { await admin.em.getConnection().execute(`DROP DATABASE IF EXISTS "${database}"`); await admin.close(true); }
});
async function scenario() {
  const playerId = randomUUID();
  const wallet = await store.openWallet(playerId, { amount: '100.00', currency: 'BRL' });
  const payload = { providerId: 'test-provider', externalTransactionId: randomUUID(), playerId, walletId: wallet.id,
    roundId: randomUUID(), gameId: 'game', kind: 'BET' as const, money: { amount: '25.00', currency: 'BRL' } };
  const key = randomUUID();
  const message = { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...payload, idempotencyKey: key } };
  return { wallet, payload, key, message };
}
async function send(message: unknown, group = randomUUID()) {
  await sqs.send(new SendMessageCommand({ QueueUrl: inputUrl, MessageBody: JSON.stringify(message), MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
}
async function reconciled(walletId: string, amount: string) {
  const result = await new Queries(orm).reconciliation(walletId);
  expect(result.consistent).toBe(true); expect(result.storedBalance.amount).toBe(amount);
}
async function flushOutbox() {
  for (let i = 0; i < 100; i++) {
    const results = await Promise.all([publisher.publishOne(), new OutboxPublisher(orm, sqs, eventsUrl).publishOne()]);
    if (results.every(value => !value)) return;
  }
  throw new Error('Outbox did not drain');
}
async function drainEvents() {
  const ids: string[] = [];
  for (let i = 0; i < 100; i++) {
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
    if (!result.Messages?.length) break;
    for (const message of result.Messages) {
      ids.push(JSON.parse(message.Body!).eventId);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: message.ReceiptHandle! }));
    }
  }
  return ids;
}
async function killAfterWork(mode: 'consumer' | 'publisher') {
  const child = Bun.spawn([process.execPath, resolve('tests/fixtures/crash-worker.ts'), mode], {
    env: { ...process.env, DATABASE_URL: databaseUrl, INPUT_URL: inputUrl, DLQ_URL: dlqUrl, EVENTS_URL: eventsUrl }, stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout>;
  try {
    const marker = (async () => {
      let text = '';
      while (!text.includes('DURABLE_WORK_DONE')) {
        const part = await reader.read();
        if (part.done) throw new Error('Worker exited before durable work');
        text += new TextDecoder().decode(part.value);
      }
    })();
    await Promise.race([marker, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Worker marker timeout')), 10000); })]);
  } finally {
    clearTimeout(timeout!); child.kill(); await child.exited; reader.releaseLock();
  }
}

describe('Workers with real SQS and PostgreSQL', () => {
  test('consumer redelivery deduplicates using persistent inbox', async () => {
    const item = await scenario();
    await send(item.message); await consumer.poll();
    await send(item.message); await consumer.poll();
    await reconciled(item.wallet.id, '75.00');
    expect(await orm.em.getConnection().execute('SELECT message_id FROM inbox_messages WHERE message_id = ?', [item.message.messageId])).toHaveLength(1);
    const empty = await sqs.send(new ReceiveMessageCommand({ QueueUrl: inputUrl, WaitTimeSeconds: 0 }));
    expect(empty.Messages ?? []).toHaveLength(0);
  });

  test('two concurrent publishers publish committed events once and drain outbox', async () => {
    await flushOutbox();
    const ids = await drainEvents();
    const rows = await orm.em.getConnection().execute('SELECT id FROM outbox_messages WHERE published_at IS NOT NULL');
    expect(ids.length).toBe(rows.length); expect(new Set(ids).size).toBe(ids.length);
    await publisher.updateLag();
    expect(await telemetry.registry.metrics()).toContain('outbox_lag_seconds 0');
  });

  test('refund before bet is resumed by concurrent reference workers exactly once', async () => {
    const item = await scenario();
    const refund = await store.submit({ ...item.payload, kind: 'REFUND', externalTransactionId: randomUUID(), referenceExternalTransactionId: item.payload.externalTransactionId }, randomUUID(), { correlationId: item.key });
    expect(refund.status).toBe('PENDING_REFERENCE');
    await store.submit(item.payload, item.key, { correlationId: item.key });
    const future = new Date(Date.now() + 2000);
    await Promise.all([new ReferenceWorker(orm, store).tick(future), new ReferenceWorker(orm, store).tick(future)]);
    expect((await new Queries(orm).transaction(refund.transactionId)).status).toBe('PROCESSED');
    await reconciled(item.wallet.id, '100.00');
  });

  test('missing reference backoff survives restart and expires with a rejection event', async () => {
    const item = await scenario();
    const pending = await store.submit({ ...item.payload, kind: 'ROLLBACK', externalTransactionId: randomUUID(), referenceExternalTransactionId: 'missing' }, randomUUID(), { correlationId: item.key });
    const future = new Date(Date.now() + 5000);
    const restarted = await MikroORM.init(databaseConfig(databaseUrl));
    try {
      expect((await new WageringStore(restarted).retryPending(pending.transactionId, future, 2))?.status).toBe('PENDING_REFERENCE');
      expect(await new WageringStore(restarted).retryPending(pending.transactionId, future, 2)).toBeUndefined();
      const result = await new WageringStore(restarted).retryPending(pending.transactionId, new Date(future.getTime() + 3000), 2);
      expect(result?.failureCode).toBe('REFERENCE_NOT_FOUND');
    } finally { await restarted.close(true); }
    expect(await orm.em.getConnection().execute("SELECT id FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? AND event_type = 'WagerTransactionRejected'", [pending.transactionId])).toHaveLength(1);
    await reconciled(item.wallet.id, '100.00');
  });

  test('permanent malformed message goes to DLQ', async () => {
    await send({ invalid: true }); await consumer.poll();
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 0 }));
    expect(result.Messages).toHaveLength(1);
    for (const message of result.Messages ?? []) await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle! }));
  });

  test('unavailable wallet retries then reaches bounded DLQ', async () => {
    const item = await scenario(); item.message.data.walletId = randomUUID();
    await send(item.message); await consumer.poll();
    const retrying = new QueueConsumer(sqs, inputUrl, dlqUrl, store, telemetry, { waitSeconds: 1, maxAttempts: 2 });
    let received = false;
    for (let attempt = 0; attempt < 8 && !received; attempt++) { received = await retrying.poll(); if (!received) await pause(500); }
    expect(received).toBe(true);
    const dlq = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 1 }));
    expect(dlq.Messages).toHaveLength(1);
    for (const message of dlq.Messages ?? []) await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle! }));
    await reconciled(item.wallet.id, '100.00');
  });

  test('consumer killed after commit before ack restarts without another debit', async () => {
    const item = await scenario(); await send(item.message);
    await killAfterWork('consumer'); await pause(1300);
    const restarted = await MikroORM.init(databaseConfig(databaseUrl));
    try {
      await new QueueConsumer(sqs, inputUrl, dlqUrl, new WageringStore(restarted), telemetry, { waitSeconds: 0 }).poll();
      await reconciled(item.wallet.id, '75.00');
      expect(await orm.em.getConnection().execute("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [item.wallet.id])).toHaveLength(1);
    } finally { await restarted.close(true); }
  });

  test('publisher killed after sending can restart with the same stable event id', async () => {
    await flushOutbox(); await drainEvents();
    const item = await scenario();
    await killAfterWork('publisher');
    await flushOutbox();
    const ids = await drainEvents();
    const row = (await orm.em.getConnection().execute('SELECT id,published_at FROM outbox_messages WHERE aggregate_id = ?', [item.wallet.id]))[0];
    expect(row?.published_at).not.toBeNull();
    expect(ids).toEqual([row?.id]);
    await reconciled(item.wallet.id, '100.00');
  });

  test('publication outage schedules a durable retry that another publisher can resume', async () => {
    await flushOutbox(); await drainEvents();
    const item = await scenario();
    await new OutboxPublisher(orm, sqs, `${eventsUrl}-missing`, telemetry).publishOne();
    const row = (await orm.em.getConnection().execute('SELECT attempts,published_at,next_attempt_at FROM outbox_messages WHERE aggregate_id = ?', [item.wallet.id]))[0];
    expect(row?.attempts).toBe(1); expect(row?.published_at).toBeNull();
    await new OutboxPublisher(orm, sqs, eventsUrl).publishOne(new Date(Date.now() + 5000));
    expect((await drainEvents()).length).toBe(1);
  });

  test('stopped consumer does not acquire new work', async () => {
    const stopped = new QueueConsumer(sqs, inputUrl, dlqUrl, store);
    stopped.stop(); expect(await stopped.poll()).toBe(false);
  });
});
