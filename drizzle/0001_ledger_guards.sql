-- Ledger integrity guards. These make the accounting invariants hold at the database level,
-- independent of application code.

-- 1. Immutable history: journals, ledger entries, trades, price ticks and breaker events are
--    append-only. Corrections must be posted as new compensating journals.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER trades_append_only BEFORE UPDATE OR DELETE ON trades
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER price_ticks_append_only BEFORE UPDATE OR DELETE ON price_ticks
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER circuit_breaker_events_append_only BEFORE UPDATE OR DELETE ON circuit_breaker_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- 2. Ledger lines inherit instrument and timestamp from their account / journal, so they can
--    never disagree with them.
CREATE FUNCTION ledger_entry_fill_derived() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  journal_created_at timestamptz;
BEGIN
  SELECT a.asset_id INTO NEW.asset_id FROM accounts a WHERE a.id = NEW.account_id;
  SELECT j.created_at INTO journal_created_at FROM journals j WHERE j.id = NEW.journal_id;
  NEW.created_at := journal_created_at;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_fill_derived BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_fill_derived();
--> statement-breakpoint

-- 3. Account balances are a cache of SUM(ledger_entries.amount) maintained only here. The
--    accounts_non_negative CHECK turns any overdraft into a failed (rolled back) transaction.
CREATE FUNCTION ledger_entry_apply_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts
     SET balance = balance + NEW.amount,
         updated_at = NEW.created_at
   WHERE id = NEW.account_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_apply_balance AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_apply_balance();
--> statement-breakpoint

-- 4. Balances may not be changed except through a ledger entry (trigger depth > 1).
CREATE FUNCTION accounts_guard_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.balance <> 0 THEN
    RAISE EXCEPTION 'accounts must be created with a zero balance' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'account balances can only change through ledger entries'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounts cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER accounts_guard_balance BEFORE INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balance();
--> statement-breakpoint

-- 5. Double entry: at commit time every journal must net to zero per instrument.
CREATE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced record;
BEGIN
  SELECT le.asset_id, SUM(le.amount) AS net
    INTO unbalanced
    FROM ledger_entries le
   WHERE le.journal_id = NEW.journal_id
   GROUP BY le.asset_id
  HAVING SUM(le.amount) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % is unbalanced for instrument % (net %)',
      NEW.journal_id, COALESCE(unbalanced.asset_id::text, 'USD'), unbalanced.net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_journal_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();
