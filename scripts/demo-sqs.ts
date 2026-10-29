import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqs, queueUrl } from '../src/infrastructure/messaging/sqs';

async function main() {
  const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
  const playerId = randomUUID();
  const opened = await fetch(`${api}/wallets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }) });
  if (!opened.ok) throw new Error(`Wallet creation failed: ${opened.status}`);
  const wallet = await opened.json() as { id: string };
  const externalId = randomUUID();
  const message = { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { providerId: 'demo-sqs', externalTransactionId: externalId, idempotencyKey: `demo-sqs:${externalId}`,
      playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'demo', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } } };
  const sqs = createSqs();
  try {
    const QueueUrl = await queueUrl(sqs, process.env.SQS_INPUT_QUEUE ?? 'wager-transactions.fifo');
    // Distinct transport deduplication ids deliberately exercise the persistent inbox.
    for (let i = 0; i < 3; i++) await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(message),
      MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${api}/providers/demo-sqs/wagering/transactions/${externalId}`);
      if (response.ok) {
        const result = await response.json() as { status: string };
        if (result.status !== 'PROCESSED') throw new Error(`Unexpected status ${result.status}`);
        const reconciliation = await fetch(`${api}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
        const checked = await reconciliation.json() as { consistent: boolean; storedBalance: { amount: string } };
        if (!checked.consistent || checked.storedBalance.amount !== '75.00') throw new Error('Balance reconciliation failed');
        console.log(JSON.stringify({ walletId: wallet.id, submittedCopies: 3, status: result.status,
          balance: checked.storedBalance, consistent: checked.consistent }));
        return;
      }
      if (response.status !== 404) throw new Error(`Transaction query failed: ${response.status}`);
      await pause(100);
    }
    throw new Error('Worker did not process the message in time');
  } finally { sqs.destroy(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Demo failed'); process.exitCode = 1; });
