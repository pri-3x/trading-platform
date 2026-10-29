import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ValidationError } from '../../lib/errors.js';
import { userIdOf } from '../auth.js';
import {
  ErrorResponse,
  ListOrdersQuery,
  Order,
  OrderRequest,
  PortfolioHistoryQuery,
  PortfolioHistoryResponse,
  PortfolioResponse,
} from '../schemas.js';

const security = [{ bearerAuth: [] }];
const OrderIdParams = z.object({ id: z.string().uuid() });

export const privateRoutes: FastifyPluginAsyncZod<{ c: Container }> = async (app, { c }) => {
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/orders',
    {
      schema: {
        tags: ['orders'],
        summary: 'Place a MARKET or LIMIT order (requires Idempotency-Key)',
        description:
          'MARKET orders are immediate-or-cancel against simulated liquidity. LIMIT orders execute what is ' +
          'immediately eligible and rest the remainder with funds/shares reserved. Replaying an Idempotency-Key ' +
          'with the same payload returns the original response with header Idempotent-Replayed: true; with a ' +
          'different payload returns 409.',
        security,
        headers: z.object({
          'idempotency-key': z
            .string()
            .optional()
            .describe('Required. 1-255 printable ASCII chars, scoped per user'),
        }),
        body: OrderRequest,
        response: {
          201: Order,
          400: ErrorResponse,
          401: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (!key) {
        throw new ValidationError(
          'Idempotency-Key header is required',
          undefined,
          'IDEMPOTENCY_KEY_REQUIRED',
        );
      }
      const result = await c.orders.placeOrder(userIdOf(request), request.body, key);
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.statusCode as 201).send(result.body as z.infer<typeof Order>);
    },
  );

  app.get(
    '/orders',
    {
      schema: {
        tags: ['orders'],
        summary: "List the caller's orders (newest first)",
        security,
        querystring: ListOrdersQuery,
        response: { 200: z.object({ orders: z.array(Order) }), 401: ErrorResponse },
      },
    },
    async (request) => ({
      orders: (await c.orders.listOrders(userIdOf(request), request.query)) as z.infer<
        typeof Order
      >[],
    }),
  );

  app.get(
    '/orders/:id',
    {
      schema: {
        tags: ['orders'],
        summary: "Get one of the caller's orders with its fills",
        security,
        params: OrderIdParams,
        response: { 200: Order, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      (await c.orders.getOrder(userIdOf(request), request.params.id)) as z.infer<typeof Order>,
  );

  app.delete(
    '/orders/:id',
    {
      schema: {
        tags: ['orders'],
        summary: 'Cancel the open remainder of an order and release its reservation',
        description: 'Allowed while a circuit breaker is active. Prior fills are preserved.',
        security,
        params: OrderIdParams,
        response: { 200: Order, 401: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) =>
      (await c.orders.cancelOrder(userIdOf(request), request.params.id)) as z.infer<typeof Order>,
  );

  app.get(
    '/portfolio',
    {
      schema: {
        tags: ['portfolio'],
        summary: 'Current balances, reservations, positions, cost basis and P&L',
        security,
        response: { 200: PortfolioResponse, 401: ErrorResponse },
      },
    },
    async (request) => c.portfolio.current(userIdOf(request)),
  );

  app.get(
    '/portfolio/history',
    {
      schema: {
        tags: ['portfolio'],
        summary: 'Portfolio reconstructed from the immutable ledger and historical prices at `at`',
        security,
        querystring: PortfolioHistoryQuery,
        response: { 200: PortfolioHistoryResponse, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (request) => c.portfolio.historyAt(userIdOf(request), request.query.at),
  );
};
