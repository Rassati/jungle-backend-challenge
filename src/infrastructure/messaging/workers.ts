import { createHash } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { z, ZodError } from 'zod';
import { WageringStore } from '../database/wagering-store';
import { DomainError } from '../../domain/errors';
import { OutboxMessage } from '../../domain/outbox-message';
import { log, Telemetry } from '../../observability';
import { identifier, wagerInput } from '../../application/contracts';

const envelope = z.strictObject({ messageId: identifier, type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }), correlationId: identifier.optional(),
  data: wagerInput.extend({ idempotencyKey: identifier }) });

export class QueueConsumer {
  private stopping = false;
  constructor(private readonly sqs: SQSClient, private readonly inputUrl: string, private readonly dlqUrl: string,
    private readonly store: WageringStore, private readonly telemetry = new Telemetry(),
    private readonly options: { waitSeconds?: number; visibilitySeconds?: number; maxAttempts?: number;
      afterCommit?: () => Promise<void> } = {}) {}

  stop(): void { this.stopping = true; }

  async poll(): Promise<boolean> {
    if (this.stopping) return false;
    const response = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.inputUrl, MaxNumberOfMessages: 1,
      WaitTimeSeconds: this.options.waitSeconds ?? 3, VisibilityTimeout: this.options.visibilitySeconds ?? 30,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'] }), { abortSignal: AbortSignal.timeout(6000) });
    const message = response.Messages?.[0];
    if (!message?.ReceiptHandle) return false;
    if (this.stopping) {
      await this.visibility(message, 0); return false;
    }
    const seconds = this.options.visibilitySeconds ?? 30;
    let heartbeat: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => { heartbeat = heartbeat.then(() => this.visibility(message, seconds))
      .catch(() => log({ level: 'error', event: 'visibility_extension_failed', messageId: message.MessageId })); }, Math.max(200, seconds * 1000 / 3));
    let fields: Record<string, unknown> = { correlationId: message.MessageId, messageId: message.MessageId,
      transactionId: null, walletId: null, providerId: null };
    try {
      const parsed = envelope.parse(JSON.parse(message.Body ?? ''));
      const { idempotencyKey, ...payload } = parsed.data;
      fields = { ...fields, messageId: parsed.messageId, correlationId: parsed.correlationId ?? parsed.messageId,
        walletId: payload.walletId, providerId: payload.providerId };
      const result = await this.store.submit(payload, idempotencyKey, { correlationId: String(fields.correlationId),
        inbox: { consumerName: 'wager-consumer-v1', messageId: parsed.messageId } });
      fields.transactionId = result.transactionId;
      await this.options.afterCommit?.();
      clearInterval(timer); await heartbeat;
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.inputUrl, ReceiptHandle: message.ReceiptHandle }));
      log({ level: 'info', event: 'message_committed', ...fields, status: result.status, idempotentReplay: result.idempotentReplay });
    } catch (error) {
      clearInterval(timer); await heartbeat;
      const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const permanent = error instanceof ZodError || error instanceof SyntaxError ||
        (error instanceof DomainError && error.code !== 'WALLET_NOT_FOUND');
      if (permanent || attempt >= (this.options.maxAttempts ?? 5)) {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: message.Body ?? '{}',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
          MessageDeduplicationId: createHash('sha256').update(`dlq:${message.MessageId}`).digest('hex') }));
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.inputUrl, ReceiptHandle: message.ReceiptHandle }));
        this.telemetry.dlq.inc();
        log({ level: 'error', event: 'message_dlq', ...fields, attempt, code: error instanceof DomainError ? error.code : 'MESSAGE_FAILURE' });
      } else {
        this.telemetry.retries.inc({ subsystem: 'consumer' });
        await this.visibility(message, Math.min(60, 2 ** attempt));
        log({ level: 'warn', event: 'message_retry', ...fields, attempt });
      }
    } finally { clearInterval(timer); await heartbeat; }
    return true;
  }

  private async visibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.inputUrl,
      ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }));
  }
}

export class OutboxPublisher {
  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient, private readonly eventsUrl: string,
    private readonly telemetry = new Telemetry(), private readonly afterSend?: () => Promise<void>) {}

  async publishOne(now = new Date()): Promise<boolean> {
    return this.orm.em.fork().transactional(async em => {
      const row = (await em.execute(`SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]))[0];
      if (!row) return false;
      const event = OutboxMessage.rehydrate({ id: row.id, aggregateId: row.aggregate_id, eventType: row.event_type,
        payload: row.payload, occurredAt: row.occurred_at, attempts: row.attempts, nextAttemptAt: row.next_attempt_at });
      try {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.eventsUrl, MessageBody: JSON.stringify(event.payload),
          MessageGroupId: event.aggregateId, MessageDeduplicationId: event.id }), { abortSignal: AbortSignal.timeout(5000) });
        await this.afterSend?.();
        event.markPublished(now);
      } catch {
        event.scheduleRetry(now);
        this.telemetry.retries.inc({ subsystem: 'outbox' });
        log({ level: 'warn', event: 'outbox_retry', eventId: event.id, walletId: event.aggregateId, attempt: event.attempts });
      }
      await em.execute('UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, published_at = ? WHERE id = ?',
        [event.attempts, event.nextAttemptAt, event.publishedAt ?? null, event.id]);
      return true;
    });
  }

  async updateLag(): Promise<void> {
    const row = (await this.orm.em.getConnection().execute(`SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float AS lag
      FROM outbox_messages WHERE published_at IS NULL`))[0];
    this.telemetry.lag.set(Math.max(0, Number(row?.lag ?? 0)));
  }
}

export class ReferenceWorker {
  constructor(private readonly orm: MikroORM, private readonly store: WageringStore) {}
  async tick(now = new Date()): Promise<number> {
    const rows = await this.orm.em.getConnection().execute(`SELECT id FROM wager_transactions
      WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ? ORDER BY next_attempt_at,id LIMIT 20`, [now]);
    let processed = 0;
    for (const row of rows) if (await this.store.retryPending(row.id, now)) processed++;
    return processed;
  }
}
