import { resetEmailConfig } from './email.config';
import { resolveTransport, resetTransport } from './email.transport';
import { MemoryTransport } from './memory.transport';
import { SmtpTransport } from './smtp.transport';
import { SesTransport } from './ses.transport';
import { ReservedDomainGuard } from './delivery-guard';
import { EmailPermanentError } from './email.types';

/**
 * Sets the environment of a developer's machine with production SES credentials
 * in the root `.env` — the exact shape that mailed every team in the dev
 * database (issue #415).
 */
function devEnvWithRealSmtp(): void {
  process.env.NODE_ENV = 'development';
  process.env.EMAIL_TRANSPORT = 'smtp';
  process.env.SMTP_HOST = 'email-smtp.eu-north-1.amazonaws.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'AKIAFAKE';
  process.env.SMTP_PASSWORD = 'smtp-password';
  process.env.APP_URL = 'http://localhost:5173';
}

describe('real-delivery guard', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetEmailConfig();
    resetTransport();
  });

  afterEach(() => {
    process.env = { ...saved };
    resetEmailConfig();
    resetTransport();
  });

  it('refuses SMTP delivery outside production and falls back to memory', () => {
    devEnvWithRealSmtp();
    delete process.env.EMAIL_ALLOW_REAL_DELIVERY;

    expect(resolveTransport()).toBeInstanceOf(MemoryTransport);
  });

  it('refuses SES delivery outside production and falls back to memory', () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_TRANSPORT = 'ses';
    process.env.SES_REGION = 'eu-north-1';
    process.env.SES_ACCESS_KEY_ID = 'AKIAFAKE';
    process.env.SES_SECRET_ACCESS_KEY = 'secret';
    process.env.APP_URL = 'http://localhost:5173';
    delete process.env.EMAIL_ALLOW_REAL_DELIVERY;

    expect(resolveTransport()).toBeInstanceOf(MemoryTransport);
  });

  it('allows SMTP delivery outside production when EMAIL_ALLOW_REAL_DELIVERY=true', () => {
    devEnvWithRealSmtp();
    process.env.EMAIL_ALLOW_REAL_DELIVERY = 'true';

    const transport = resolveTransport();
    expect(transport).toBeInstanceOf(ReservedDomainGuard);
    expect((transport as ReservedDomainGuard).inner).toBeInstanceOf(SmtpTransport);
  });

  it('allows SES delivery in production without any opt-in', () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_TRANSPORT = 'ses';
    process.env.SES_REGION = 'eu-north-1';
    process.env.SES_ACCESS_KEY_ID = 'AKIAFAKE';
    process.env.SES_SECRET_ACCESS_KEY = 'secret';
    process.env.APP_URL = 'https://acruxcore.com';
    delete process.env.EMAIL_ALLOW_REAL_DELIVERY;

    const transport = resolveTransport();
    expect(transport).toBeInstanceOf(ReservedDomainGuard);
    expect((transport as ReservedDomainGuard).inner).toBeInstanceOf(SesTransport);
  });
});

describe('ReservedDomainGuard', () => {
  const message = {
    to: '',
    from: 'acruxcore <no-reply@acruxcore.com>',
    subject: 'Your weekly digest',
    html: '<p>hi</p>',
    text: 'hi',
  };

  it.each([
    'alice@example.com',
    'bob@EXAMPLE.ORG',
    'carol@example.net',
    'dave@acme.invalid',
    'erin@staging.test',
    'frank@localhost',
  ])('refuses %s without reaching the transport', async (to) => {
    const inner = new MemoryTransport();
    const guard = new ReservedDomainGuard(inner);

    await expect(guard.send({ ...message, to })).rejects.toBeInstanceOf(
      EmailPermanentError,
    );
    expect(inner.sent()).toHaveLength(0);
  });

  it('delivers to a real address', async () => {
    const inner = new MemoryTransport();
    const guard = new ReservedDomainGuard(inner);

    const { providerMessageId } = await guard.send({
      ...message,
      to: 'talha@acruxcore.com',
    });

    expect(providerMessageId).toBe('memory-1');
    expect(inner.sent()).toHaveLength(1);
  });
});
