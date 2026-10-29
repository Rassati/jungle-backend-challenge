import { DomainError } from './errors';

export class InboxMessage {
  private constructor(public readonly consumerName: string, public readonly messageId: string,
    public readonly payloadHash: string, private _processedAt?: Date) {}
  static receive(props: { consumerName: string; messageId: string; payloadHash: string }): InboxMessage {
    if (!props.consumerName || !props.messageId) throw new DomainError('INVALID_MESSAGE_ID', 'Message identity is required.');
    return new this(props.consumerName, props.messageId, props.payloadHash);
  }
  static rehydrate(props: { consumerName: string; messageId: string; payloadHash: string; processedAt?: Date }): InboxMessage {
    return new this(props.consumerName, props.messageId, props.payloadHash, props.processedAt ? new Date(props.processedAt) : undefined);
  }
  matches(hash: string): boolean { return hash === this.payloadHash; }
  isProcessed(): boolean { return !!this._processedAt; }
  get processedAt(): Date | undefined { return this._processedAt ? new Date(this._processedAt) : undefined; }
  markProcessed(at: Date): void { if (!this.isProcessed()) this._processedAt = new Date(at); }
}
