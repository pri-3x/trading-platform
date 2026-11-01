import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bootstrap } from './bootstrap.js';
import { buildApp } from './http/app.js';

let ready: Promise<FastifyInstance> | undefined;

async function init(): Promise<FastifyInstance> {
  const app = await buildApp(bootstrap(), { httpLogging: true });
  await app.ready();
  return app;
}

/**
 * Vercel serverless entry point. One Fastify instance per warm function instance; the price
 * simulator is never started here (functions are frozen between requests), so prices must be
 * ticked by a long-running process elsewhere (e.g. the Render web service) on the same database.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= init().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  const app = await ready;
  app.server.emit('request', req, res);
}
