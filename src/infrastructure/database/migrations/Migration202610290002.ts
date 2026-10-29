import { Migration } from '@mikro-orm/migrations';

export class Migration202610290002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT processed_reversal_requires_reference
      CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL)`);
  }

  override async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT processed_reversal_requires_reference');
  }
}
