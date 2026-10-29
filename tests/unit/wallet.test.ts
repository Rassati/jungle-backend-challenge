import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-29T12:00:00.000Z');
const context = { entryId: 'entry-1', transactionId: 'transaction-1', at };
const open = (amount = '100.00') => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(amount), at });

describe('Wallet and ledger', () => {
  test('opens at version 1 with an opening credit for positive balance', () => {
    const wallet = open();
    const entry = wallet.openingEntry(context)!;
    expect(wallet.version).toBe(1);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('100.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('does not produce opening ledger for a zero balance', () => {
    expect(open('0').openingEntry(context)).toBeUndefined();
  });

  test('debit changes balance and version and returns matching ledger', () => {
    const wallet = open();
    const entry = wallet.debit(brl('80'), context);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejected debit leaves balance, version and timestamp intact', () => {
    const wallet = open('20');
    expect(() => wallet.debit(brl('80'), context)).toThrow();
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  });

  test('permits spending the exact remaining balance', () => {
    const wallet = open('20');
    wallet.debit(brl('20'), context);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('credits match ledger and advance version', () => {
    const wallet = open();
    const entry = wallet.credit(brl('25'), context);
    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.isBalanced()).toBe(true);
  });

  test('has a distinct failure code for reversal debit without funds', () => {
    const wallet = open('0');
    try {
      wallet.debit(brl('20'), context, 'REVERSAL_INSUFFICIENT_FUNDS');
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toHaveProperty('code', 'REVERSAL_INSUFFICIENT_FUNDS');
    }
  });

  test('rejects negative opening, zero/negative movements and currency mismatch', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1').negate() })).toThrow();
    const wallet = open();
    for (const amount of [brl('0'), brl('1').negate(), Money.from({ amount: '1', currency: 'USD' })]) {
      expect(() => wallet.debit(amount, context)).toThrow();
      expect(() => wallet.credit(amount, context)).toThrow();
    }
    expect(wallet.version).toBe(1);
  });

  test('rejects an inconsistent ledger entry', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'e', walletId: 'w', transactionId: 't', direction: 'DEBIT', money: brl('25'),
      balanceBefore: brl('100'), balanceAfter: brl('90'), createdAt: at,
    })).toThrow();
  });

  test('does not expose mutable dates through getters or creation arguments', () => {
    const inputDate = new Date(at);
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10'), at: inputDate });
    const entry = wallet.debit(brl('1'), { ...context, at: inputDate });
    inputDate.setFullYear(2000);
    wallet.updatedAt.setFullYear(2001);
    entry.createdAt.setFullYear(2002);
    expect(wallet.updatedAt).toEqual(at);
    expect(wallet.createdAt).toEqual(at);
    expect(entry.createdAt).toEqual(at);
  });

  test('rehydrates balance/version without replaying movements', () => {
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('42'), version: 8, createdAt: at, updatedAt: at });
    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(8);
  });
});
