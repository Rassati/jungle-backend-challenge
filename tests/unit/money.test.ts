import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('adds cents exactly and serializes with a fixed scale', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
  });

  test('preserves cents above JavaScript safe integer range', () => {
    expect(brl('9007199254740993.01').add(brl('0.01')).toString()).toBe('9007199254740993.02');
  });

  test('operations return new values without modifying their operands', () => {
    const balance = brl('100.00');
    const bet = brl('25.00');
    const result = balance.subtract(bet);
    expect(result.toString()).toBe('75.00');
    expect(balance.toString()).toBe('100.00');
    expect(bet.toString()).toBe('25.00');
    expect(result).not.toBe(balance);
  });

  test('allows signed calculation results for reconciliation', () => {
    expect(brl('10').subtract(brl('20')).toString()).toBe('-10.00');
    expect(brl('10').negate().isNegative()).toBe(true);
    expect(brl('10').negate().negate().equals(brl('10'))).toBe(true);
  });

  test('exposes comparisons and zero', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1').isLessThan(brl('2'))).toBe(true);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
  });

  test.each(['NaN', 'Infinity', '', ' ', '1e2', '1.001', '-1.00', '+1', '1,00', '.50', '1.', ' 1.00', '1.00 '])(
    'rejects invalid input %j instead of silently rounding it', (amount) => {
      expect(() => brl(amount)).toThrow();
    },
  );

  test('rejects numeric input even if runtime callers bypass TypeScript', () => {
    expect(() => Money.from({ amount: 12 as unknown as string, currency: 'BRL' })).toThrow();
  });

  test('rejects mismatched currencies for arithmetic and comparisons', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1').add(usd)).toThrow();
    expect(() => brl('1').subtract(usd)).toThrow();
    expect(() => brl('1').equals(usd)).toThrow();
    expect(() => brl('1').isLessThan(usd)).toThrow();
  });

  test('enforces the database range before persistence', () => {
    expect(() => brl('1000000000000000000.00')).toThrow();
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow();
    expect(brl('999999999999999999.99').toString()).toBe('999999999999999999.99');
  });

  test.each(['brl', '', 'REAL', '12A'])('rejects malformed currency %j', (currency) => {
    expect(() => Money.zero(currency)).toThrow();
  });
});
