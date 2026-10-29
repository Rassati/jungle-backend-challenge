import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';
import type { WagerKind } from '../domain/wager-transaction';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerKind, 'OPENING'>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function sortedJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${sortedJSON(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(payload: WagerPayload): string {
  // Explicit allowlist excludes headers and transport metadata from identity.
  const businessFields = {
    providerId: payload.providerId, externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId, walletId: payload.walletId, roundId: payload.roundId,
    gameId: payload.gameId, kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(sortedJSON(businessFields)).digest('hex');
}
