import { randomUUID } from 'node:crypto';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { payloadHash, type WagerPayload } from '../../application/payload-hash';
import { DomainError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import { WagerTransaction, type FailureCode, type WagerKind, type WagerStatus } from '../../domain/wager-transaction';
import { IntegrationEvent, WalletBalanceChanged, WagerTransactionProcessed,
  WagerTransactionRejected, WagerTransactionPendingReference } from '../../domain/integration-event';
import { WalletSchema } from './config';

export interface TransactionResult {
  transactionId: string;
  status: WagerStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

interface TransactionRow {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string;
  payload_hash: string; wallet_id: string; player_id: string; round_id: string; game_id: string;
  kind: WagerKind; amount: string; currency: string; status: WagerStatus;
  reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  failure_code: FailureCode | null; created_at: Date; processed_at: Date | null;
  result: TransactionResult;
}

export interface SubmissionContext {
  correlationId: string;
  inbox?: { consumerName: string; messageId: string };
}

export class WageringStore {
  constructor(private readonly orm: MikroORM) {}

  async openWallet(playerId: string, initialBalance: MoneyProps): Promise<{
    id: string; playerId: string; balance: MoneyProps; version: number;
  }> {
    const money = Money.from(initialBalance);
    if (money.currency !== 'BRL') throw new DomainError('UNSUPPORTED_CURRENCY', 'Only BRL is accepted.');
    return this.orm.em.fork().transactional(async em => {
      const at = new Date();
      const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance: money, at });
      const inserted = await em.execute(`INSERT INTO wallets (id,player_id,currency,balance,version,created_at,updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT (player_id,currency) DO NOTHING RETURNING id`,
      [wallet.id, playerId, money.currency, money.toString(), at, at]);
      if (inserted.length === 0) throw new DomainError('WALLET_CONFLICT', 'Player already has a wallet in this currency.');
      const transactionId = randomUUID();
      const entry = wallet.openingEntry({ entryId: randomUUID(), transactionId, at });
      if (entry) {
        await em.execute(`INSERT INTO wager_transactions
          (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,processed_at)
          VALUES (?, 'internal', ?, ?, ?, ?, ?, 'opening', 'internal', 'OPENING', ?, ?, 'PROCESSED', ?, ?)`,
        [transactionId, transactionId, `opening:${wallet.id}`, '0'.repeat(64), wallet.id, playerId, money.toString(), money.currency, at, at]);
        await this.saveLedger(em, entry);
        await this.saveEvent(em, WalletBalanceChanged.from({ eventId: randomUUID(), aggregateId: wallet.id,
          correlationId: transactionId, occurredAt: at, data: this.balanceData(wallet, entry) }));
      }
      return { id: wallet.id, playerId, balance: money.toJSON(), version: wallet.version };
    });
  }

  async submit(payload: WagerPayload, idempotencyKey: string, context: SubmissionContext): Promise<TransactionResult> {
    const hash = payloadHash(payload);
    const tx = WagerTransaction.create({ ...payload, id: randomUUID(), idempotencyKey,
      payloadHash: hash, money: Money.from(payload.money), createdAt: new Date() });
    if (tx.money.currency !== 'BRL') throw new DomainError('UNSUPPORTED_CURRENCY', 'Only BRL is accepted.');
    return this.orm.em.fork().transactional(async em => {
      // All callers acquire the wallet lock first, including future retry workers.
      const record = await em.findOne(WalletSchema, { id: payload.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!record) throw new DomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
      if (record.currency !== payload.money.currency) throw new DomainError('CURRENCY_MISMATCH', 'Currency differs from wallet.');
      const wallet = Wallet.rehydrate({ ...record, balance: Money.from({ amount: record.balance, currency: record.currency }) });
      if (context.inbox) {
        await em.execute(`INSERT INTO inbox_messages (consumer_name,message_id,payload_hash,received_at)
          VALUES (?, ?, ?, now()) ON CONFLICT DO NOTHING`, [context.inbox.consumerName, context.inbox.messageId, hash]);
        const inbox = (await em.execute(`SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ? FOR UPDATE`,
          [context.inbox.consumerName, context.inbox.messageId]))[0];
        if (inbox?.payload_hash !== hash) throw new DomainError('INBOX_CONFLICT', 'Message id was reused with a different payload.');
      }
      const inserted = await em.execute(`INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      [tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, hash, tx.walletId, tx.playerId,
        tx.roundId, tx.gameId, tx.kind, tx.money.toString(), tx.money.currency, tx.referenceExternalTransactionId ?? null, tx.createdAt]);
      if (inserted.length === 0) {
        const rows: TransactionRow[] = await em.execute(`SELECT * FROM wager_transactions
          WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?)`,
        [idempotencyKey, payload.providerId, payload.externalTransactionId]);
        const previous = rows.find(row => row.idempotency_key === idempotencyKey);
        if (!previous || previous.payload_hash !== hash || rows.length !== 1 || !previous.result) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Key or external transaction id conflicts with another operation.');
        }
        await this.finishInbox(em, context);
        return { ...previous.result, idempotentReplay: true };
      }
      const refRow: TransactionRow | undefined = tx.referenceExternalTransactionId
        ? (await em.execute<TransactionRow[]>('SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
          [tx.providerId, tx.referenceExternalTransactionId]))[0] : undefined;
      const ref = refRow ? this.rehydrateTransaction(refRow) : undefined;
      const reversed = ref && tx.requiresReference() ? (await em.execute(`SELECT id FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED'`, [ref.id, tx.kind])).length > 0 : false;
      const at = new Date();
      const entry = tx.apply(wallet, { entryId: randomUUID(), at }, ref, reversed);
      if (entry) {
        record.balance = wallet.balance.toString();
        record.version = wallet.version;
        record.updatedAt = wallet.updatedAt;
        await em.flush();
        await this.saveLedger(em, entry);
      }
      const result: TransactionResult = { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(),
        ...(tx.failureCode ? { failureCode: tx.failureCode } : {}), idempotentReplay: false };
      await em.execute(`UPDATE wager_transactions SET status = ?, reference_transaction_id = ?, failure_code = ?,
        processed_at = ?, result = ?::jsonb, next_attempt_at = ? WHERE id = ?`,
      [tx.status, tx.referenceTransactionId ?? null, tx.failureCode ?? null, tx.processedAt ?? null,
        JSON.stringify(result), tx.status === 'PENDING_REFERENCE' ? new Date(at.getTime() + 1000) : null, tx.id]);
      const props = { eventId: randomUUID(), aggregateId: wallet.id, correlationId: context.correlationId,
        causationId: context.inbox?.messageId, occurredAt: at, data: { ...result, providerId: tx.providerId } };
      const event = tx.status === 'PROCESSED' ? WagerTransactionProcessed.from(props)
        : tx.status === 'REJECTED' ? WagerTransactionRejected.from(props) : WagerTransactionPendingReference.from(props);
      await this.saveEvent(em, event);
      if (entry) await this.saveEvent(em, WalletBalanceChanged.from({ ...props, eventId: randomUUID(), data: this.balanceData(wallet, entry) }));
      await this.finishInbox(em, context);
      return result;
    });
  }

  private rehydrateTransaction(row: TransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({ id: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, walletId: row.wallet_id, playerId: row.player_id,
      roundId: row.round_id, gameId: row.game_id, kind: row.kind, money: Money.from({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      referenceTransactionId: row.reference_transaction_id ?? undefined, status: row.status,
      failureCode: row.failure_code ?? undefined, createdAt: row.created_at, processedAt: row.processed_at ?? undefined });
  }

  private async saveLedger(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.execute(`INSERT INTO wallet_ledger_entries (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [entry.id, entry.walletId, entry.transactionId, entry.direction,
      entry.money.toString(), entry.money.currency, entry.balanceBefore.toString(), entry.balanceAfter.toString(), entry.createdAt]);
  }

  private async saveEvent(em: EntityManager, event: IntegrationEvent): Promise<void> {
    const json = event.toJSON();
    await em.execute(`INSERT INTO outbox_messages (id,aggregate_id,event_type,payload,occurred_at) VALUES (?, ?, ?, ?::jsonb, ?)`,
      [json.eventId, json.aggregateId, json.eventType, JSON.stringify(json), json.occurredAt]);
  }

  private balanceData(wallet: Wallet, entry: WalletLedgerEntry): Record<string, unknown> {
    return { walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version };
  }

  private async finishInbox(em: EntityManager, context: SubmissionContext): Promise<void> {
    if (context.inbox) await em.execute(`UPDATE inbox_messages SET processed_at = now() WHERE consumer_name = ? AND message_id = ?`,
      [context.inbox.consumerName, context.inbox.messageId]);
  }
}
