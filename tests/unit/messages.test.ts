import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';

describe('Persistent message models', () => {
  test('inbox identity matches content and processing timestamp cannot be overwritten', () => {
    const message = InboxMessage.receive({ consumerName: 'consumer', messageId: 'message', payloadHash: 'hash' });
    expect(message.isProcessed()).toBe(false);
    expect(message.matches('hash')).toBe(true);
    expect(message.matches('other')).toBe(false);
    message.markProcessed(new Date(1000));
    message.markProcessed(new Date(2000));
    expect(message.processedAt?.getTime()).toBe(1000);
  });
  test('outbox retries back off, cap at 300 seconds and stop after publication', () => {
    const now = new Date();
    const event = OutboxMessage.rehydrate({ id: 'e', aggregateId: 'w', eventType: 'test', payload: { value: 'text' },
      occurredAt: now, nextAttemptAt: now, attempts: 0 });
    expect(event.isDue(now)).toBe(true);
    event.scheduleRetry(now);
    expect(event.attempts).toBe(1);
    expect(event.nextAttemptAt.getTime() - now.getTime()).toBe(2000);
    for (let i = 0; i < 20; i++) event.scheduleRetry(now);
    expect(event.nextAttemptAt.getTime() - now.getTime()).toBe(300000);
    event.markPublished(now);
    expect(event.isDue(now)).toBe(false);
    expect(() => event.scheduleRetry(now)).toThrow();
  });
});
