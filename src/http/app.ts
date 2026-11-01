import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type { Container } from '../container.js';
import { authPlugin } from './auth.js';
import { registerErrorHandling } from './error-handler.js';
import { privateRoutes } from './routes/private.routes.js';
import { publicRoutes } from './routes/public.routes.js';

export async function buildApp(
  c: Container,
  opts: { httpLogging?: boolean } = {},
): Promise<FastifyInstance> {
  const loggerOpts: Pick<FastifyServerOptions, 'logger' | 'loggerInstance'> = opts.httpLogging
    ? { loggerInstance: c.logger }
    : { logger: false };
  const app = Fastify({
    ...loggerOpts,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    bodyLimit: 64 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Tokenized Pre-IPO Trading Platform',
        version: '1.0.0',
        description:
          'Simulated trading of fictional pre-IPO share tokens against a USD stablecoin. ' +
          'All monetary values are decimal strings: cash 8dp, shares 6dp, prices 2dp.',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      tags: [
        { name: 'auth' },
        { name: 'market' },
        { name: 'orders' },
        { name: 'portfolio' },
        { name: 'system' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  app.get('/', { schema: { hide: true } }, (_request, reply) => reply.redirect('/docs'));
  await app.register(authPlugin, {
    secret: c.config.jwt.secret,
    expiresIn: c.config.jwt.expiresIn,
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(publicRoutes, { c });
  await app.register(privateRoutes, { c });
  return app;
}
