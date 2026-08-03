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
