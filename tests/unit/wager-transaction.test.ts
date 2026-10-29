import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, type CreateWagerProps, type WagerStatus } from '../../src/domain/wager-transaction';
import { payloadHash, type WagerPayload } from '../../src/application/payload-hash';

const at = new Date('2026-10-29T12:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const wallet = (amount = '100') => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl(amount), at });
const props = (overrides: Partial<CreateWagerProps> = {}): CreateWagerProps => ({
  id: 't', providerId: 'provider', externalTransactionId: 'ext', idempotencyKey: 'key', payloadHash: 'hash',
  walletId: 'w', playerId: 'p', roundId: 'r', gameId: 'g', kind: 'BET', money: brl('25'), createdAt: at, ...overrides,
});
const context = { entryId: 'entry', at };
const processedBet = () => {
  const bet = WagerTransaction.create(props());
  bet.apply(wallet(), context);
  return bet;
};

describe('WagerTransaction', () => {
  test('BET debits and WIN credits', () => {
    const w = wallet();
    const bet = WagerTransaction.create(props());
    expect(bet.apply(w, context)?.direction).toBe('DEBIT');
    expect(bet.status).toBe('PROCESSED');
    const win = WagerTransaction.create(props({ kind: 'WIN' }));
    expect(win.apply(w, context)?.direction).toBe('CREDIT');
    expect(w.balance.toString()).toBe('100.00');
  });

  test('LOSS records success without changing balance, version or ledger', () => {
    const w = wallet();
    const tx = WagerTransaction.create(props({ kind: 'LOSS', money: brl('0') }));
    expect(tx.apply(w, context)).toBeUndefined();
    expect(tx.status).toBe('PROCESSED');
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('insufficient funds rejects without a ledger entry', () => {
    const w = wallet('20');
    const tx = WagerTransaction.create(props());
    expect(tx.apply(w, context)).toBeUndefined();
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.status).toBe('REJECTED');
    expect(w.balance.toString()).toBe('20.00');
  });

  test('REFUND credits the exact referenced bet', () => {
    const tx = WagerTransaction.create(props({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
    const w = wallet('75');
    expect(tx.apply(w, context, processedBet())?.direction).toBe('CREDIT');
    expect(w.balance.toString()).toBe('100.00');
    expect(tx.referenceTransactionId).toBe('t');
  });

  test.each(['BET', 'WIN', 'REFUND'] as const)('ROLLBACK reverses %s', kind => {
    const ref = WagerTransaction.rehydrate({ ...props({ kind }), status: 'PROCESSED' });
    const tx = WagerTransaction.create(props({ kind: 'ROLLBACK', externalTransactionId: 'rollback', referenceExternalTransactionId: 'ext' }));
    const w = wallet('75');
    expect(tx.apply(w, context, ref)?.direction).toBe(kind === 'BET' ? 'CREDIT' : 'DEBIT');
    expect(w.balance.toString()).toBe(kind === 'BET' ? '100.00' : '50.00');
  });

  test('rollback debit without funds uses a distinct rejection code', () => {
    const ref = WagerTransaction.rehydrate({ ...props({ kind: 'WIN' }), status: 'PROCESSED' });
    const tx = WagerTransaction.create(props({ kind: 'ROLLBACK', externalTransactionId: 'rollback', referenceExternalTransactionId: 'ext' }));
    const w = wallet('0');
    expect(tx.apply(w, context, ref)).toBeUndefined();
    expect(tx.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(w.balance.toString()).toBe('0.00');
  });

  test('out-of-order reversal waits and can be processed when reference arrives', () => {
    const tx = WagerTransaction.create(props({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
    const w = wallet('75');
    expect(tx.apply(w, context)).toBeUndefined();
    expect(tx.status).toBe('PENDING_REFERENCE');
    tx.apply(w, context, processedBet());
    expect(tx.status).toBe('PROCESSED');
    expect(w.balance.toString()).toBe('100.00');
  });

  test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)(
    'rejects a reference with different %s', field => {
      const ref = WagerTransaction.rehydrate({ ...props({ [field]: 'other' }), status: 'PROCESSED' });
      const tx = WagerTransaction.create(props({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
      tx.apply(wallet(), context, ref);
      expect(tx.failureCode).toBe('REFERENCE_MISMATCH');
    },
  );

  test('rejects a reference with a different currency', () => {
    const ref = WagerTransaction.rehydrate({ ...props({ money: Money.from({ amount: '25', currency: 'USD' }) }), status: 'PROCESSED' });
    const tx = WagerTransaction.create(props({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
    tx.apply(wallet(), context, ref);
    expect(tx.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('does not allow partial or repeated reversals', () => {
    const partial = WagerTransaction.create(props({ kind: 'REFUND', money: brl('10'), externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
    partial.apply(wallet(), context, processedBet());
    expect(partial.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const repeated = WagerTransaction.create(props({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
    repeated.apply(wallet(), context, processedBet(), true);
    expect(repeated.failureCode).toBe('ALREADY_REVERSED');
  });

  test('rejects invalid reference kind and failed references', () => {
    const tx = () => WagerTransaction.create(props({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'ext' }));
    const wrongKind = tx();
    wrongKind.apply(wallet(), context, WagerTransaction.rehydrate({ ...props({ kind: 'WIN' }), status: 'PROCESSED' }));
    expect(wrongKind.failureCode).toBe('INVALID_REFERENCE_KIND');
    const rejected = tx();
    rejected.apply(wallet(), context, WagerTransaction.rehydrate({ ...props(), status: 'REJECTED' }));
    expect(rejected.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  test.each(['PROCESSED', 'REJECTED', 'FAILED'] as WagerStatus[])('terminal %s cannot change or move funds', status => {
    const tx = WagerTransaction.rehydrate({ ...props(), status });
    const w = wallet();
    expect(() => tx.apply(w, context)).toThrow();
    expect(() => tx.markProcessed(undefined, at)).toThrow();
    expect(() => tx.markPendingReference()).toThrow();
    expect(() => tx.reject('INSUFFICIENT_FUNDS')).toThrow();
    expect(() => tx.fail('INFRASTRUCTURE_FAILURE')).toThrow();
    expect(w.balance.toString()).toBe('100.00');
  });

  test('requires valid kinds, amounts and references at creation', () => {
    expect(() => WagerTransaction.create(props({ kind: 'OPENING' }))).toThrow();
    expect(() => WagerTransaction.create(props({ kind: 'REFUND' }))).toThrow();
    expect(() => WagerTransaction.create(props({ money: brl('0') }))).toThrow();
    expect(() => WagerTransaction.create(props({ kind: 'LOSS' }))).toThrow();
    expect(() => WagerTransaction.create(props({ referenceExternalTransactionId: 'ext' }))).toThrow();
  });

  test('matches payload hashes without confusing a conflict with a replay', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.matchesPayload('hash')).toBe(true);
    expect(tx.matchesPayload('different')).toBe(false);
  });
});

describe('Canonical business payload hash', () => {
  const data: WagerPayload = { providerId: 'provider', externalTransactionId: 'ext', playerId: 'p', walletId: 'w',
    roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };

  test('key order does not matter, including nested money fields', () => {
    expect(payloadHash(data)).toBe(payloadHash({ ...data, money: { currency: 'BRL', amount: '25.00' } }));
  });

  test('business changes cause a conflict while transport metadata is ignored', () => {
    expect(payloadHash(data)).not.toBe(payloadHash({ ...data, money: { amount: '26.00', currency: 'BRL' } }));
    const withTransport = { ...data, messageId: 'message', idempotencyKey: 'header', correlationId: 'trace' };
    expect(payloadHash(data)).toBe(payloadHash(withTransport));
  });
});
