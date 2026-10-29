import { DomainError } from './errors';
import { Money } from './money';
import { Wallet } from './wallet';
import type { WalletLedgerEntry } from './ledger-entry';

export type WagerKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type FailureCode =
  | 'INSUFFICIENT_FUNDS' | 'REVERSAL_INSUFFICIENT_FUNDS' | 'WALLET_MISMATCH'
  | 'CURRENCY_MISMATCH' | 'REFERENCE_MISMATCH' | 'INVALID_REFERENCE_KIND'
  | 'REFERENCE_NOT_PROCESSED' | 'REFERENCE_AMOUNT_MISMATCH' | 'ALREADY_REVERSED'
  | 'REFERENCE_NOT_FOUND' | 'AMOUNT_OUT_OF_RANGE' | 'INFRASTRUCTURE_FAILURE';

export interface CreateWagerProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerState extends CreateWagerProps {
  status: WagerStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidTransactionStateError extends DomainError {
  constructor() { super('INVALID_TRANSACTION_STATE', 'Terminal transactions cannot change state.'); }
}

export class WagerTransaction {
  private constructor(private state: WagerState) {}

  static create(props: CreateWagerProps): WagerTransaction {
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(props.kind)) {
      throw new DomainError('INVALID_KIND', 'Only public wagering operations are accepted.');
    }
    const required = [props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId];
    if (required.some(value => typeof value !== 'string' || value.trim().length === 0)) {
      throw new DomainError('INVALID_IDENTIFIER', 'Transaction identifiers must be non-empty strings.');
    }
    if ((props.kind === 'LOSS' && !props.money.isZero()) ||
      (props.kind !== 'LOSS' && !props.money.isPositive())) {
      throw new DomainError('INVALID_TRANSACTION_AMOUNT', 'LOSS requires zero; financial movements require positive amounts.');
    }
    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && (typeof reference !== 'string' || !reference.trim())) {
      throw new DomainError('INVALID_REFERENCE', 'Reference must be a non-empty string.');
    }
    if ((props.kind === 'REFUND' || props.kind === 'ROLLBACK') && reference === undefined) {
      throw new DomainError('REFERENCE_REQUIRED', 'Reversal requires the provider transaction reference.');
    }
    if (reference === props.externalTransactionId) {
      throw new DomainError('INVALID_REFERENCE', 'A transaction cannot reference itself.');
    }
    if (props.kind === 'BET' && reference !== undefined) {
      throw new DomainError('INVALID_REFERENCE', 'BET cannot reference another transaction.');
    }
    return WagerTransaction.rehydrate({ ...props, status: 'PENDING' });
  }

  static rehydrate(state: WagerState): WagerTransaction {
    return new WagerTransaction({ ...state, createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined });
  }

  get id(): string { return this.state.id; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get idempotencyKey(): string { return this.state.idempotencyKey; }
  get payloadHash(): string { return this.state.payloadHash; }
  get walletId(): string { return this.state.walletId; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string { return this.state.roundId; }
  get gameId(): string { return this.state.gameId; }
  get kind(): WagerKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get status(): WagerStatus { return this.state.status; }
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }

  isTerminal(): boolean { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== 'LOSS'; }
  requiresReference(): boolean { return this.kind === 'REFUND' || this.kind === 'ROLLBACK'; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertActive();
    if ((this.requiresReference() || this.referenceExternalTransactionId !== undefined) && !referenceTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', 'Referenced transactions must be resolved before processing.');
    }
    this.state = { ...this.state, status: 'PROCESSED', referenceTransactionId, processedAt: new Date(at) };
  }

  markPendingReference(): void {
    this.assertActive();
    if (!this.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', 'Only referenced operations can wait for a reference.');
    }
    this.state = { ...this.state, status: 'PENDING_REFERENCE' };
  }

  reject(code: FailureCode): void {
    this.assertActive();
    this.state = { ...this.state, status: 'REJECTED', failureCode: code };
  }

  fail(code: FailureCode): void {
    this.assertActive();
    this.state = { ...this.state, status: 'FAILED', failureCode: code };
  }

  /** Called with the wallet locked and reversal uniqueness checked by persistence. */
  apply(wallet: Wallet, context: { entryId: string; at: Date }, reference?: WagerTransaction,
    alreadyReversed = false): WalletLedgerEntry | undefined {
    this.assertActive();
    if (wallet.id !== this.walletId || wallet.playerId !== this.playerId) {
      this.reject('WALLET_MISMATCH'); return;
    }
    if (wallet.currency !== this.money.currency) {
      this.reject('CURRENCY_MISMATCH'); return;
    }
    if (this.referenceExternalTransactionId) {
      if (!reference) { this.markPendingReference(); return; }
      const mismatch = reference.providerId !== this.providerId || reference.walletId !== this.walletId ||
        reference.playerId !== this.playerId || reference.roundId !== this.roundId ||
        reference.money.currency !== this.money.currency || reference.externalTransactionId !== this.referenceExternalTransactionId;
      if (mismatch) { this.reject('REFERENCE_MISMATCH'); return; }
      const allowed = this.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
      if (!allowed.includes(reference.kind)) { this.reject('INVALID_REFERENCE_KIND'); return; }
      if (!reference.isTerminal()) { this.markPendingReference(); return; }
      if (reference.status !== 'PROCESSED') { this.reject('REFERENCE_NOT_PROCESSED'); return; }
      if (this.requiresReference() && !this.money.equals(reference.money)) {
        this.reject('REFERENCE_AMOUNT_MISMATCH'); return;
      }
      if (this.requiresReference() && alreadyReversed) { this.reject('ALREADY_REVERSED'); return; }
    }
    let entry: WalletLedgerEntry | undefined;
    const movement = { ...context, transactionId: this.id };
    try {
      if (this.kind === 'BET' || (this.kind === 'ROLLBACK' && reference?.kind !== 'BET')) {
        entry = wallet.debit(this.money, movement,
          this.kind === 'ROLLBACK' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
      } else if (this.kind !== 'LOSS') {
        entry = wallet.credit(this.money, movement);
      }
    } catch (error) {
      if (error instanceof DomainError && ['INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'AMOUNT_OUT_OF_RANGE'].includes(error.code)) {
        this.reject(error.code as FailureCode); return;
      }
      throw error;
    }
    this.markProcessed(reference?.id, context.at);
    return entry;
  }

  private assertActive(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
  }
}
