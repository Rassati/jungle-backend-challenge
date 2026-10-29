import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from './infrastructure/database/config';
import { createApp } from './http/app';

async function main(): Promise<void> {
  const orm = await MikroORM.init(databaseConfig());
  const { app, dispose } = await createApp(orm);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await app.close();
    dispose();
    await orm.close(true);
  }
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try {
    const port = Number(process.env.PORT ?? '3000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
    await app.listen(port, process.env.HOST ?? '127.0.0.1');
    console.log(JSON.stringify({ level: 'info', event: 'api_started', port }));
  } catch (error) { await stop(); throw error; }
}
main().catch(() => { console.error(JSON.stringify({ level: 'error', event: 'startup_failed' })); process.exitCode = 1; });
