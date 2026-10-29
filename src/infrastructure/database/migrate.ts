import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from './config';

async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  if (direction !== 'up' && direction !== 'down') throw new Error('Expected migration direction: up or down');
  const orm = await MikroORM.init(databaseConfig());
  try {
    if (direction === 'up') await orm.getMigrator().up();
    else await orm.getMigrator().down();
  } finally {
    await orm.close(true);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
