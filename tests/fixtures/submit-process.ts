import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { WageringStore } from '../../src/infrastructure/database/wagering-store';

async function main(): Promise<void> {
 const orm = await MikroORM.init(databaseConfig());
 try {
  const input = JSON.parse(process.argv[2]!);
  const result = await new WageringStore(orm).submit(input.payload, input.key, { correlationId: input.key });
  process.stdout.write(JSON.stringify(result));
 } finally {
  await orm.close(true);
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
