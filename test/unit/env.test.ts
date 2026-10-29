import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', JWT_SECRET: 'x'.repeat(32) };

describe('loadEnv', () => {
  it('applies defaults and keeps decimals as strings', () => {
    const env = loadEnv(base);
    expect(env.CIRCUIT_BREAKER_THRESHOLD).toBe('0.15');
    expect(env.SIMULATOR_ENABLED).toBe(true);
  });

  it('rejects missing or weak secrets and bad values', () => {
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadEnv({ ...base, CIRCUIT_BREAKER_THRESHOLD: '0.1.5' })).toThrow(
      /CIRCUIT_BREAKER_THRESHOLD/,
    );
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'change-me-dev-only-secret-at-least-32-characters',
      }),
    ).toThrow(/placeholder/);
  });
});
