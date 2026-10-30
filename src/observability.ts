import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), correlationId: null, messageId: null,
    transactionId: null, walletId: null, providerId: null, ...fields }));
}

export class Telemetry {
  readonly registry = new Registry();
  readonly transactions = new Counter({ name: 'wager_transactions_total', help: 'Committed operation results', labelNames: ['status'], registers: [this.registry] });
  readonly duplicates = new Counter({ name: 'wager_duplicates_total', help: 'Persistent replays', registers: [this.registry] });
  readonly retries = new Counter({ name: 'wager_retries_total', help: 'Retries by subsystem', labelNames: ['subsystem'], registers: [this.registry] });
  readonly dlq = new Counter({ name: 'wager_dlq_total', help: 'Messages forwarded to DLQ', registers: [this.registry] });
  readonly ackFailures = new Counter({ name: 'wager_ack_failures_total', help: 'Failed SQS message deletion attempts', registers: [this.registry] });
  readonly lockConflicts = new Counter({ name: 'wager_lock_conflicts_total', help: 'Lock timeouts and deadlocks', registers: [this.registry] });
  readonly lag = new Gauge({ name: 'outbox_lag_seconds', help: 'Age of oldest unpublished event', registers: [this.registry] });
  readonly processing = new Histogram({ name: 'wager_processing_seconds', help: 'Transaction processing latency', registers: [this.registry] });
}
