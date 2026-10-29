import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { WageringStore } from '../../src/infrastructure/database/wagering-store';
import { createSqs } from '../../src/infrastructure/messaging/sqs';
import { OutboxPublisher, QueueConsumer } from '../../src/infrastructure/messaging/workers';

async function main() {
  const orm = await MikroORM.init(databaseConfig());
  const sqs = createSqs();
  const pauseAfterDurableWork = async () => {
    process.stdout.write('DURABLE_WORK_DONE\n');
    await new Promise<void>(() => {});
  };
  if (process.argv[2] === 'consumer') {
    await new QueueConsumer(sqs, process.env.INPUT_URL!, process.env.DLQ_URL!, new WageringStore(orm), undefined,
      { waitSeconds: 0, visibilitySeconds: 1, afterCommit: pauseAfterDurableWork }).poll();
  } else {
    await new OutboxPublisher(orm, sqs, process.env.EVENTS_URL!, undefined, pauseAfterDurableWork).publishOne();
  }
  sqs.destroy(); await orm.close(true);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
