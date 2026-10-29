import { z } from 'zod';

export const identifier = z.string().min(1).max(200).refine(value => value.trim() === value);
export const uuid = z.uuid();
export const moneyInput = z.strictObject({ amount: z.string().max(24).regex(/^\d+(?:\.\d{1,2})?$/), currency: z.literal('BRL') });
export const openWalletInput = z.strictObject({ playerId: uuid, initialBalance: moneyInput });
export const wagerInput = z.strictObject({
  providerId: identifier.refine(value => value !== 'internal', 'Reserved provider'),
  externalTransactionId: identifier, playerId: uuid, walletId: uuid, roundId: identifier, gameId: identifier,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']), money: moneyInput,
  referenceExternalTransactionId: identifier.optional(),
});
export const ledgerQuery = z.strictObject({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional().default(50),
});
