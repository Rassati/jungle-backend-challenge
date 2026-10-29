import { Migration } from '@mikro-orm/migrations';

export class Migration202610290001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency),
        UNIQUE (id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL CHECK (length(provider_id) > 0),
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL,
        currency char(3) NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        failure_code text,
        result jsonb,
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        UNIQUE (id, wallet_id, currency),
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)
      );
      CREATE UNIQUE INDEX one_processed_reversal_per_kind
        ON wager_transactions(reference_transaction_id, kind)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
      CREATE INDEX pending_references_due ON wager_transactions(next_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        UNIQUE (transaction_id, wallet_id),
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        CHECK ((direction = 'DEBIT' AND balance_after = balance_before - amount)
          OR (direction = 'CREDIT' AND balance_after = balance_before + amount))
      );
      CREATE INDEX wallet_ledger_cursor ON wallet_ledger_entries(wallet_id, created_at, id);

      CREATE FUNCTION protect_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger is append-only' USING ERRCODE = '23514';
        RETURN NULL;
      END;
      $$;
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION protect_ledger();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION protect_ledger();

      CREATE FUNCTION protect_terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'Terminal transaction is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER terminal_transaction_no_update BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_terminal_transaction();

      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      );
      CREATE INDEX outbox_due ON outbox_messages(next_attempt_at, id) WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE outbox_messages;
      DROP TABLE inbox_messages;
      DROP TABLE wallet_ledger_entries;
      DROP TABLE wager_transactions;
      DROP TABLE wallets;
      DROP FUNCTION protect_ledger();
      DROP FUNCTION protect_terminal_transaction();
    `);
  }
}
