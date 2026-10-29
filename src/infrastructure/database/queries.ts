import { MikroORM } from '@mikro-orm/postgresql';
import { DomainError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { WalletSchema } from './config';

export class Queries {
  constructor(private readonly orm: MikroORM) {}

  async wallet(id: string) {
    const row = await this.orm.em.fork().findOne(WalletSchema, { id });
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
    return { id: row.id, playerId: row.playerId, balance: { amount: row.balance, currency: row.currency }, version: row.version };
  }

  async transaction(id: string | { providerId: string; externalId: string }) {
    const condition = typeof id === 'string' ? 'id = ?' : 'provider_id = ? AND external_transaction_id = ?';
    const args = typeof id === 'string' ? [id] : [id.providerId, id.externalId];
    const row = (await this.orm.em.getConnection().execute(`SELECT * FROM wager_transactions WHERE ${condition}`, args))[0];
    if (!row) throw new DomainError('TRANSACTION_NOT_FOUND', 'Transaction does not exist.');
    return { transactionId: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id, playerId: row.player_id, roundId: row.round_id, gameId: row.game_id,
      kind: row.kind, money: { amount: row.amount, currency: row.currency }, status: row.status,
      referenceExternalTransactionId: row.reference_external_transaction_id, referenceTransactionId: row.reference_transaction_id,
      failureCode: row.failure_code, createdAt: row.created_at, processedAt: row.processed_at, result: row.result };
  }

  async ledger(walletId: string, limit: number, cursor?: string) {
    await this.wallet(walletId);
    let point: { time: string; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (decoded.walletId !== walletId || typeof decoded.time !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.time) ||
          Number.isNaN(Date.parse(decoded.time)) || typeof decoded.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)) throw new Error();
        point = decoded;
      } catch { throw new DomainError('INVALID_CURSOR', 'Cursor is invalid for this wallet.'); }
    }
    const rows = await this.orm.em.getConnection().execute(`SELECT *,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM wallet_ledger_entries WHERE wallet_id = ? ${point ? 'AND (created_at,id) > (?::timestamptz,?::uuid)' : ''}
      ORDER BY created_at,id LIMIT ?`, [walletId, ...(point ? [point.time, point.id] : []), limit + 1]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(row => ({ id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id,
      direction: row.direction, money: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency }, createdAt: row.cursor_time })),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ walletId, time: last.cursor_time, id: last.id })).toString('base64url') : null };
  }

  async reconciliation(walletId: string) {
    // A single SQL statement sees the wallet and ledger in the same MVCC snapshot.
    const row = (await this.orm.em.getConnection().execute(`SELECT w.balance::text AS stored, w.currency,
      COALESCE(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS calculated,
      count(l.id)::integer AS checked_entries FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`, [walletId]))[0];
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
    const stored = Money.from({ amount: row.stored, currency: row.currency });
    const negative = row.calculated.startsWith('-');
    const magnitude = Money.from({ amount: negative ? row.calculated.slice(1) : row.calculated, currency: row.currency });
    const calculated = negative ? magnitude.negate() : magnitude;
    const difference = stored.subtract(calculated);
    return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(), consistent: difference.isZero(), checkedEntries: row.checked_entries };
  }
}
