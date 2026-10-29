import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Decimal-valued settings stay strings so they never pass through floating point. */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  INITIAL_USER_FUNDING: decimalString.default('100000'),
  SEED_USER_EMAIL: z.string().email().default('alice@example.com'),
  SEED_USER_PASSWORD: z.string().min(8).default('password123'),

  SIMULATOR_ENABLED: bool.default(true),
  SIMULATOR_TICK_MS: z.coerce.number().int().min(50).default(1000),
  SIMULATOR_SEED: z.coerce.number().int().default(42),
  SIMULATOR_VOLATILITY: decimalString.default('0.6'),
  SIMULATOR_DRIFT: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .default('0.05'),

  LIQUIDITY_LEVELS: z.coerce.number().int().min(1).max(50).default(5),
  LIQUIDITY_HALF_SPREAD_BPS: z.coerce.number().int().min(0).max(1000).default(10),
  LIQUIDITY_LEVEL_STEP_BPS: z.coerce.number().int().min(0).max(1000).default(10),
  LIQUIDITY_LEVEL_NOTIONAL_USD: decimalString.default('25000'),

  MIN_ORDER_NOTIONAL_USD: decimalString.default('1'),
  MAX_ORDER_QUANTITY: decimalString.default('1000000'),

  CIRCUIT_BREAKER_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  CIRCUIT_BREAKER_THRESHOLD: decimalString.default('0.15'),
  CIRCUIT_BREAKER_HALT_SECONDS: z.coerce.number().int().min(1).default(30),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.includes('change-me')) {
    throw new Error(
      'Invalid environment configuration: JWT_SECRET still uses the development placeholder',
    );
  }
  return parsed.data;
}

/** Strongly typed application configuration derived from the environment. */
export interface AppConfig {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  jwt: { secret: string; expiresIn: string };
  initialUserFunding: string;
  simulator: { enabled: boolean; tickMs: number; seed: number; volatility: string; drift: string };
  liquidity: {
    levels: number;
    halfSpreadBps: number;
    levelStepBps: number;
    levelNotionalUsd: string;
  };
  trading: { minOrderNotionalUsd: string; maxOrderQuantity: string };
  circuitBreaker: { windowSeconds: number; threshold: string; haltSeconds: number };
}

export function toAppConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    jwt: { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN },
    initialUserFunding: env.INITIAL_USER_FUNDING,
    simulator: {
      enabled: env.SIMULATOR_ENABLED,
      tickMs: env.SIMULATOR_TICK_MS,
      seed: env.SIMULATOR_SEED,
      volatility: env.SIMULATOR_VOLATILITY,
      drift: env.SIMULATOR_DRIFT,
    },
    liquidity: {
      levels: env.LIQUIDITY_LEVELS,
      halfSpreadBps: env.LIQUIDITY_HALF_SPREAD_BPS,
      levelStepBps: env.LIQUIDITY_LEVEL_STEP_BPS,
      levelNotionalUsd: env.LIQUIDITY_LEVEL_NOTIONAL_USD,
    },
    trading: {
      minOrderNotionalUsd: env.MIN_ORDER_NOTIONAL_USD,
      maxOrderQuantity: env.MAX_ORDER_QUANTITY,
    },
    circuitBreaker: {
      windowSeconds: env.CIRCUIT_BREAKER_WINDOW_SECONDS,
      threshold: env.CIRCUIT_BREAKER_THRESHOLD,
      haltSeconds: env.CIRCUIT_BREAKER_HALT_SECONDS,
    },
  };
}
