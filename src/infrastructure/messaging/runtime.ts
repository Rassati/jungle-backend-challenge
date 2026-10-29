import { setTimeout as pause } from 'node:timers/promises';
import { MikroORM } from '@mikro-orm/postgresql';
import { log, Telemetry } from '../../observability';
import { WageringStore } from '../database/wagering-store';
import { createSqs, queueUrl } from './sqs';
import { OutboxPublisher, QueueConsumer, ReferenceWorker } from './workers';

export async function startWorkers(orm: MikroORM, telemetry: Telemetry) {
  const sqs = createSqs();
  let input: string, dlq: string, events: string;
  try {
    [input, dlq, events] = await Promise.all([
      queueUrl(sqs, process.env.SQS_INPUT_QUEUE ?? 'wager-transactions.fifo'),
      queueUrl(sqs, process.env.SQS_DLQ_QUEUE ?? 'wager-transactions-dlq.fifo'),
      queueUrl(sqs, process.env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo'),
    ]);
  } catch (error) { sqs.destroy(); throw error; }
  const store = new WageringStore(orm, telemetry);
  const consumer = new QueueConsumer(sqs, input, dlq, store, telemetry);
  const publisher = new OutboxPublisher(orm, sqs, events, telemetry);
  const references = new ReferenceWorker(orm, store);
  const controller = new AbortController();
  async function loop(name: string, action: () => Promise<unknown>, delay: number) {
    while (!controller.signal.aborted) {
      try { await action(); }
      catch { log({ level: 'error', event: 'worker_iteration_failed', worker: name }); }
      try { await pause(delay, undefined, { signal: controller.signal }); } catch { break; }
    }
  }
  const tasks = [loop('consumer', () => consumer.poll(), 50), loop('outbox', () => publisher.publishOne(), 100),
    loop('references', () => references.tick(), 1000), loop('outbox_metrics', () => publisher.updateLag(), 1000)];
  return {
    async stop() {
      consumer.stop(); controller.abort();
      await Promise.allSettled(tasks);
      sqs.destroy();
      log({ level: 'info', event: 'workers_stopped' });
    },
  };
}
