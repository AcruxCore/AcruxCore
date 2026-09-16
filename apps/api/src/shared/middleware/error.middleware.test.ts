import express from 'express';
import request from 'supertest';
import { errorMiddleware } from './error.middleware';
import { NotFoundError } from '../errors';
import { createApp } from '../../../app';
import { signupTestUser, authHeaders } from '../../test-utils/auth';

/**
 * A tiny real Express app whose one route throws what the test wants to see handled.
 *
 * Every assertion below is on a real HTTP response: status line, headers and bytes on
 * the wire. The behaviours under test are about what can and cannot be written once a
 * response has started, and a hand-rolled Response double cannot express that — it
 * will happily accept a `status()` call that the real `http.ServerResponse` rejects
 * with ERR_HTTP_HEADERS_SENT.
 */
function appThrowing(handler: express.RequestHandler): express.Express {
  const app = express();
  app.get('/boom', handler);
  app.use(errorMiddleware);
  return app;
}

describe('errorMiddleware — malformed values (issue #476)', () => {
  it('answers 400 for a malformed id, through the real stack', async () => {
    // Driven through a real route with a real Prisma client rather than a
    // constructed error: P2023 is what Postgres raises for a value it cannot
    // coerce, and the point is that the real driver's real error is mapped.
    const app = createApp();
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .get('/api/v1/prompts/not-a-uuid-at-all')
      .set(authHeaders(ctx));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBeDefined();
    // Prisma's own message carries the failing query and a source path; neither
    // may travel back to the caller.
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|invocation|\.ts:/i);
  }, 60000);

  it('leaves an unrecognised failure on the generic 500 path', async () => {
    const app = appThrowing(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred.');
  });
});

describe('errorMiddleware — response already started (issue #484)', () => {
  it('closes an SSE stream with an error frame and [DONE]', async () => {
    const app = appThrowing((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"delta":"Hel"}\n\n');
      throw new NotFoundError('Budget not found.');
    });

    const res = await request(app).get('/boom');

    // The status line was already 200 and cannot be changed — the recovery is in
    // the body, which must end in a way a client can distinguish from a dropped
    // connection.
    expect(res.status).toBe(200);
    expect(res.text).toContain('data: {"delta":"Hel"}');
    expect(res.text).toContain('"code":"NOT_FOUND"');
    expect(res.text).toContain('Budget not found.');
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('ends a non-SSE response without writing a second status line', async () => {
    const app = appThrowing((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial answer');
      throw new Error('boom');
    });

    const res = await request(app).get('/boom');

    // Writing a status here throws ERR_HTTP_HEADERS_SENT, and finalhandler then
    // destroys the socket; the response must simply end instead.
    expect(res.status).toBe(200);
    expect(res.text).toBe('partial answer');
  });

  it('does not write into a response that has already ended', async () => {
    // The client-abort shape: the handler finishes the response, and only then
    // does something reject. `res.write` on an ended response raises
    // ERR_STREAM_WRITE_AFTER_END from inside the final error handler, where
    // Express has nothing left to catch it with.
    const app = appThrowing((_req, res, next) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
      next(new NotFoundError('Budget not found.'));
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(200);
    expect(res.text).toBe('data: [DONE]\n\n');
    expect(res.text).not.toContain('NOT_FOUND');
  });

  it('still answers normally when the response has not started', async () => {
    const app = appThrowing(() => {
      throw new NotFoundError('Budget not found.');
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Budget not found.' });
  });
});
