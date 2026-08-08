import request from 'supertest';
import { createApp } from '../../app';
import { closeRedisConnection } from '../evaluations/queue/connection';

const app = createApp();

afterAll(async () => {
  await closeRedisConnection();
});

describe('GET /api/v1/health', () => {
  it('reports ok with database and redis checks when both dependencies are reachable', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('ok');
    expect(typeof res.body.checks.database.latencyMs).toBe('number');
    expect(res.body.checks.redis.status).toBe('ok');
    expect(typeof res.body.checks.redis.latencyMs).toBe('number');
  });

  it('requires no authentication', async () => {
    const res = await request(app).get('/api/v1/health').set('Authorization', '');

    expect(res.status).not.toBe(401);
  });
});
