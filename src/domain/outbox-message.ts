import { DomainError } from './errors';

export interface OutboxState {
  id: string; aggregateId: string; eventType: string; payload: Record<string, unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt: Date; publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private state: OutboxState) {}
  static rehydrate(state: OutboxState): OutboxMessage {
    return new this({ ...state, payload: structuredClone(state.payload), occurredAt: new Date(state.occurredAt),
      nextAttemptAt: new Date(state.nextAttemptAt), publishedAt: state.publishedAt ? new Date(state.publishedAt) : undefined });
  }
  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get payload(): Record<string, unknown> { return structuredClone(this.state.payload); }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date { return new Date(this.state.nextAttemptAt); }
  get publishedAt(): Date | undefined { return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined; }
  isPending(): boolean { return !this.state.publishedAt; }
  isDue(now: Date): boolean { return this.isPending() && this.state.nextAttemptAt <= now; }
  markPublished(at: Date): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', 'Event was already published.');
    this.state = { ...this.state, publishedAt: new Date(at) };
  }
  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', 'Published event cannot be retried.');
    const attempts = this.attempts + 1;
    this.state = { ...this.state, attempts, nextAttemptAt: new Date(now.getTime() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 20))) };
  }
}
