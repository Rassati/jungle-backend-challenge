export interface EventProps {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;
  protected constructor(private readonly props: EventProps) {
    this.props = structuredClone(props);
  }
  toJSON(): Record<string, unknown> {
    return { ...structuredClone(this.props), eventType: this.eventType, version: this.version,
      occurredAt: this.props.occurredAt.toISOString() };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';
  static from(props: EventProps): WagerTransactionProcessed { return new this(props); }
}
export class WagerTransactionRejected extends IntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';
  static from(props: EventProps): WagerTransactionRejected { return new this(props); }
}
export class WagerTransactionPendingReference extends IntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';
  static from(props: EventProps): WagerTransactionPendingReference { return new this(props); }
}
export class WalletBalanceChanged extends IntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';
  static from(props: EventProps): WalletBalanceChanged { return new this(props); }
}
