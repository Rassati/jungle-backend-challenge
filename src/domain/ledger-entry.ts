import { DomainError } from './errors';
import { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.money.isPositive()) {
      throw new DomainError('INVALID_LEDGER_AMOUNT', 'Ledger amount must be positive.');
    }
    if (state.direction !== 'DEBIT' && state.direction !== 'CREDIT') {
      throw new DomainError('INVALID_LEDGER_DIRECTION', 'Ledger direction must be DEBIT or CREDIT.');
    }
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new DomainError('NEGATIVE_BALANCE', 'Ledger balances cannot be negative.');
    }
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) {
      throw new DomainError('UNBALANCED_LEDGER', 'Ledger arithmetic does not match balances.');
    }
    return entry;
  }

  // Rehydration reconstructs trusted persisted state without replaying business rules.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...state, createdAt: new Date(state.createdAt) }));
  }

  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get transactionId(): string { return this.state.transactionId; }
  get direction(): LedgerDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get balanceBefore(): Money { return this.state.balanceBefore; }
  get balanceAfter(): Money { return this.state.balanceAfter; }
  get createdAt(): Date { return new Date(this.state.createdAt); }

  isBalanced(): boolean {
    const expected = this.direction === 'DEBIT'
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
