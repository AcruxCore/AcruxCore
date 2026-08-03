import {
  PaymentRequiredError,
  RateLimitedError,
  BadGatewayError,
  GatewayTimeoutError,
  PayloadTooLargeError,
  UnprocessableError,
} from './http-errors';

describe('Phase 2 gateway error classes', () => {
  it('PaymentRequiredError → 402 PAYMENT_REQUIRED', () => {
    const err = new PaymentRequiredError('Budget exceeded.');
    expect(err.statusCode).toBe(402);
    expect(err.code).toBe('PAYMENT_REQUIRED');
    expect(err.message).toBe('Budget exceeded.');
  });

  it('PaymentRequiredError(code, message) sets a custom code', () => {
    const err = new PaymentRequiredError('BUDGET_EXCEEDED', 'Team budget exhausted.');
    expect(err.statusCode).toBe(402);
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.message).toBe('Team budget exhausted.');
  });

  it('RateLimitedError → 429 RATE_LIMITED and carries retryAfter', () => {
    const err = new RateLimitedError('Slow down.', 30);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfter).toBe(30);
  });

  it('BadGatewayError → 502 PROVIDER_ERROR', () => {
    const err = new BadGatewayError('Upstream failed.');
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('PROVIDER_ERROR');
  });

  it('GatewayTimeoutError → 504 PROVIDER_TIMEOUT', () => {
    const err = new GatewayTimeoutError();
    expect(err.statusCode).toBe(504);
    expect(err.code).toBe('PROVIDER_TIMEOUT');
  });

  it('PayloadTooLargeError → 413 PAYLOAD_TOO_LARGE', () => {
    const err = new PayloadTooLargeError();
    expect(err.statusCode).toBe(413);
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('PayloadTooLargeError accepts a custom message', () => {
    const err = new PayloadTooLargeError('Batch has 201 spans; the per-request limit is 200.');
    expect(err.statusCode).toBe(413);
    expect(err.message).toBe('Batch has 201 spans; the per-request limit is 200.');
  });

  it('UnprocessableError → 422 UNPROCESSABLE', () => {
    const err = new UnprocessableError('No eligible feedback rows.');
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('UNPROCESSABLE');
    expect(err.message).toBe('No eligible feedback rows.');
  });
});
