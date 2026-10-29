import { EntitySchema } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration202610290001 } from './migrations/Migration202610290001';

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// Persistence metadata is separate from domain classes; monetary values remain strings.
export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord', tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});

export function databaseConfig(clientUrl = process.env.DATABASE_URL ??
  'postgresql://jungle:jungle-local-only@localhost:55432/jungle') {
  return defineConfig({
    clientUrl,
    entities: [WalletSchema],
    extensions: [Migrator],
    migrations: { migrationsList: [Migration202610290001], transactional: true, allOrNothing: true },
    pool: { min: 0, max: 10 },
  });
}
