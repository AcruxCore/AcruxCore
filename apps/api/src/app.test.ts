import request from 'supertest';
import { createApp } from '../app';

const app = createApp();

describe('security headers (Finding #18)', () => {
  it('helmet sets baseline security headers and hides X-Powered-By', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

/**
 * Body-parser rejections are the client's fault, so they must not surface as
 * 500 INTERNAL_ERROR (issue #336). `express.json()` throws before any route or
 * auth middleware runs, which is why none of these send a credential.
 */
describe('body-parser failures map to 4xx, not 500 (issue #336)', () => {
  it('malformed JSON returns 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Content-Type', 'application/json')
      .send('not-valid-json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('the 400 does not echo the unparseable body back to the client', async () => {
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Content-Type', 'application/json')
      .send('{"leaked":"s3cret-payload-value"');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('s3cret-payload-value');
  });

  it('a body over the parser limit returns 413 PAYLOAD_TOO_LARGE', async () => {
    // express.json() defaults to a 100KB limit; 200KB of valid JSON clears it.
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('an unsupported Content-Encoding returns 415 UNSUPPORTED_ENCODING', async () => {
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'not-an-encoding')
      .send('{"ok":true}');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_ENCODING');
  });
});
