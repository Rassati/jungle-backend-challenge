import { DomainError } from './errors';
import { WalletLedgerEntry, type LedgerDirection } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export class Wallet {
  private constructor(private state: WalletState) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('NEGATIVE_BALANCE', 'Initial balance cannot be negative.');
    }
    const at = props.at ?? new Date();
    return Wallet.rehydrate({
      id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: at, updatedAt: at,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) });
  }

  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.state.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }

  openingEntry(context: MovementContext): WalletLedgerEntry | undefined {
    if (this.balance.isZero()) return undefined;
    if (this.version !== 1) {
      throw new DomainError('INVALID_OPENING_STATE', 'Opening entry requires an unmodified wallet.');
    }
    return WalletLedgerEntry.create({
      id: context.entryId, transactionId: context.transactionId, walletId: this.id,
      direction: 'CREDIT', money: this.balance, balanceBefore: Money.zero(this.currency),
      balanceAfter: this.balance, createdAt: context.at,
    });
  }

  debit(money: Money, context: MovementContext, failureCode = 'INSUFFICIENT_FUNDS'): WalletLedgerEntry {
    this.assertMovement(money);
    if (this.balance.isLessThan(money)) {
      throw new DomainError(failureCode, 'Wallet has insufficient funds.');
    }
    return this.move('DEBIT', money, context);
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    return this.move('CREDIT', money, context);
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Movement currency must match wallet currency.');
    }
    if (!money.isPositive()) {
      throw new DomainError('INVALID_MOVEMENT_AMOUNT', 'Balance movements must be positive.');
    }
  }

  private move(direction: LedgerDirection, money: Money, context: MovementContext): WalletLedgerEntry {
    const nextBalance = direction === 'DEBIT' ? this.balance.subtract(money) : this.balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: context.entryId, walletId: this.id, transactionId: context.transactionId,
      direction, money, balanceBefore: this.balance, balanceAfter: nextBalance, createdAt: context.at,
    });
    // Change state only after every validation has succeeded.
    this.state = { ...this.state, balance: nextBalance, version: this.version + 1, updatedAt: new Date(context.at) };
    return entry;
  }
}
