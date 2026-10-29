import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { UnauthorizedError } from '../lib/errors.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

/** Bearer-JWT authentication. Every private route adds `onRequest: app.authenticate`. */
export const authPlugin = fp(
  async (app: FastifyInstance, opts: { secret: string; expiresIn: string }) => {
    await app.register(fastifyJwt, { secret: opts.secret, sign: { expiresIn: opts.expiresIn } });
    app.decorate('authenticate', async (request: FastifyRequest) => {
      try {
        await request.jwtVerify();
      } catch {
        throw new UnauthorizedError('missing or invalid bearer token');
      }
    });
  },
);

export function userIdOf(request: FastifyRequest): string {
  return request.user.sub;
}
