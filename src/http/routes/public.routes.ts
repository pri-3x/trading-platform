import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Container } from '../../container.js';
import {
  AssetDetail,
  AssetSummary,
  AuthRequest,
  AuthResponse,
  CalculatorRequest,
  CalculatorResponse,
  ErrorResponse,
} from '../schemas.js';

export const publicRoutes: FastifyPluginAsyncZod<{ c: Container }> = async (app, { c }) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness + database connectivity',
        response: { 200: z.object({ status: z.literal('ok'), time: z.string() }) },
      },
    },
    async () => {
      await c.database.db.execute(sql`select 1`);
      return { status: 'ok' as const, time: c.clock.now().toISOString() };
    },
  );

  app.post(
    '/auth/register',
    {
      schema: {
        tags: ['auth'],
        summary:
          'Register a user (credited with INITIAL_USER_FUNDING USD stablecoin) and return a JWT',
        body: AuthRequest,
        response: { 201: AuthResponse, 400: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const user = await c.auth.register(request.body.email, request.body.password);
      const token = await reply.jwtSign({ sub: user.id, email: user.email });
      return reply
        .status(201)
        .send({ token, tokenType: 'Bearer' as const, expiresIn: c.config.jwt.expiresIn, user });
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange email/password for a JWT bearer token',
        body: AuthRequest,
        response: { 200: AuthResponse, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (request, reply) => {
      const user = await c.auth.authenticate(request.body.email, request.body.password);
      const token = await reply.jwtSign({ sub: user.id, email: user.email });
      return { token, tokenType: 'Bearer' as const, expiresIn: c.config.jwt.expiresIn, user };
    },
  );

  app.get(
    '/assets',
    {
      schema: {
        tags: ['market'],
        summary: 'List assets with their latest simulated price and trading status',
        response: { 200: z.object({ assets: z.array(AssetSummary) }) },
      },
    },
    async () => ({ assets: await c.assets.listAssets() }),
  );

  app.get(
    '/assets/:symbol',
    {
      schema: {
        tags: ['market'],
        summary: 'Asset details, current price, price history and recent circuit-breaker events',
        params: z.object({ symbol: z.string().min(1).max(16) }),
        querystring: z.object({
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(5000).default(500),
        }),
        response: { 200: AssetDetail, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { from, to, limit } = request.query;
      return c.assets.getAsset(request.params.symbol, {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit,
      });
    },
  );

  app.post(
    '/calculator',
    {
      schema: {
        tags: ['market'],
        summary: 'Indicative USD -> shares conversion (read-only, never creates orders)',
        body: CalculatorRequest,
        response: { 200: CalculatorResponse, 400: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request) => c.calculator.calculate(request.body.symbol, request.body.usdAmount),
  );
};
