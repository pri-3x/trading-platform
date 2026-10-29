CREATE TABLE "accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"asset_id" integer,
	"type" text NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"balance" numeric(38, 8) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_owner_instrument_type_uq" UNIQUE NULLS NOT DISTINCT("user_id","asset_id","type"),
	CONSTRAINT "accounts_non_negative" CHECK ("accounts"."allow_negative" or "accounts"."balance" >= 0),
	CONSTRAINT "accounts_type" CHECK ("accounts"."type" in ('USER_AVAILABLE', 'USER_RESERVED', 'HOUSE_INVENTORY', 'EXTERNAL_FUNDING')),
	CONSTRAINT "accounts_owner_matches_type" CHECK (("accounts"."type" like 'USER_%') = ("accounts"."user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "asset_market_state" (
	"asset_id" integer PRIMARY KEY NOT NULL,
	"last_tick_id" bigint,
	"last_price" numeric(20, 2),
	"last_tick_at" timestamp with time zone,
	"ask_consumed" numeric(38, 6) DEFAULT '0' NOT NULL,
	"bid_consumed" numeric(38, 6) DEFAULT '0' NOT NULL,
	"halted_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ams_consumed_non_negative" CHECK ("asset_market_state"."ask_consumed" >= 0 and "asset_market_state"."bid_consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"initial_price" numeric(20, 2) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assets_symbol_unique" UNIQUE("symbol"),
	CONSTRAINT "assets_initial_price_positive" CHECK ("assets"."initial_price" > 0)
);
--> statement-breakpoint
CREATE TABLE "circuit_breaker_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"trigger_tick_id" bigint NOT NULL,
	"trigger_price" numeric(20, 2) NOT NULL,
	"reference_price" numeric(20, 2) NOT NULL,
	"reference_observed_at" timestamp with time zone NOT NULL,
	"change_ratio" numeric(30, 12) NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"halted_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"order_id" uuid,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_user_scope_key_uq" UNIQUE("user_id","scope","key"),
	CONSTRAINT "idempotency_key_length" CHECK (char_length("idempotency_records"."key") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" uuid,
	"order_id" uuid,
	"description" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "journals_type" CHECK ("journals"."type" in ('FUNDING', 'ORDER_RESERVE', 'TRADE', 'ORDER_RELEASE'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"journal_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"asset_id" integer,
	"amount" numeric(38, 8) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"quantity" numeric(38, 6) NOT NULL,
	"filled_quantity" numeric(38, 6) DEFAULT '0' NOT NULL,
	"remaining_quantity" numeric(38, 6) NOT NULL,
	"limit_price" numeric(20, 2),
	"filled_notional" numeric(38, 8) DEFAULT '0' NOT NULL,
	"reserved_initial" numeric(38, 8) DEFAULT '0' NOT NULL,
	"reserved_remaining" numeric(38, 8) DEFAULT '0' NOT NULL,
	"cancel_reason" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_filled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "orders_side" CHECK ("orders"."side" in ('BUY', 'SELL')),
	CONSTRAINT "orders_type" CHECK ("orders"."type" in ('MARKET', 'LIMIT')),
	CONSTRAINT "orders_status" CHECK ("orders"."status" in ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED')),
	CONSTRAINT "orders_quantity_positive" CHECK ("orders"."quantity" > 0),
	CONSTRAINT "orders_quantity_reconciles" CHECK ("orders"."filled_quantity" >= 0 and "orders"."remaining_quantity" >= 0 and "orders"."filled_quantity" + "orders"."remaining_quantity" = "orders"."quantity"),
	CONSTRAINT "orders_limit_price" CHECK (("orders"."type" = 'LIMIT' and "orders"."limit_price" > 0) or ("orders"."type" = 'MARKET' and "orders"."limit_price" is null)),
	CONSTRAINT "orders_reservation_bounds" CHECK ("orders"."reserved_remaining" >= 0 and "orders"."reserved_remaining" <= "orders"."reserved_initial"),
	CONSTRAINT "orders_terminal_released" CHECK ("orders"."status" in ('OPEN', 'PARTIALLY_FILLED') or "orders"."reserved_remaining" = 0),
	CONSTRAINT "orders_filled_complete" CHECK ("orders"."status" <> 'FILLED' or "orders"."remaining_quantity" = 0)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"user_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"quantity" numeric(38, 6) NOT NULL,
	"cost_basis" numeric(38, 8) NOT NULL,
	"realized_pnl" numeric(38, 8) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "positions_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id"),
	CONSTRAINT "positions_non_negative" CHECK ("positions"."quantity" >= 0 and "positions"."cost_basis" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"price" numeric(20, 2) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_ticks_price_positive" CHECK ("price_ticks"."price" > 0),
	CONSTRAINT "price_ticks_source" CHECK ("price_ticks"."source" in ('SEED', 'SIMULATOR', 'MANUAL'))
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric(38, 6) NOT NULL,
	"price" numeric(20, 2) NOT NULL,
	"notional" numeric(38, 8) NOT NULL,
	"liquidity_level" integer NOT NULL,
	"price_tick_id" bigint NOT NULL,
	"journal_id" bigint NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trades_positive" CHECK ("trades"."quantity" > 0 and "trades"."price" > 0 and "trades"."notional" > 0),
	CONSTRAINT "trades_notional_exact" CHECK ("trades"."notional" = "trades"."quantity" * "trades"."price")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_market_state" ADD CONSTRAINT "asset_market_state_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_market_state" ADD CONSTRAINT "asset_market_state_last_tick_id_price_ticks_id_fk" FOREIGN KEY ("last_tick_id") REFERENCES "public"."price_ticks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_breaker_events" ADD CONSTRAINT "circuit_breaker_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_breaker_events" ADD CONSTRAINT "circuit_breaker_events_trigger_tick_id_price_ticks_id_fk" FOREIGN KEY ("trigger_tick_id") REFERENCES "public"."price_ticks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_price_tick_id_price_ticks_id_fk" FOREIGN KEY ("price_tick_id") REFERENCES "public"."price_ticks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cbe_asset_triggered_idx" ON "circuit_breaker_events" USING btree ("asset_id","triggered_at");--> statement-breakpoint
CREATE INDEX "journals_user_created_idx" ON "journals" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "journals_order_idx" ON "journals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_created_idx" ON "ledger_entries" USING btree ("account_id","created_at","journal_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_resting_idx" ON "orders" USING btree ("asset_id","side","limit_price","created_at") WHERE "orders"."status" in ('OPEN', 'PARTIALLY_FILLED');--> statement-breakpoint
CREATE UNIQUE INDEX "price_ticks_asset_observed_uq" ON "price_ticks" USING btree ("asset_id","observed_at");--> statement-breakpoint
CREATE INDEX "trades_order_idx" ON "trades" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "trades_user_executed_idx" ON "trades" USING btree ("user_id","executed_at");