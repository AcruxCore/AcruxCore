import { encryptSecret, decryptSecret, assertMasterKey } from './crypto';

// A fixed, valid 32-byte base64 key for the round-trip cases.
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

describe('gateway connections crypto', () => {
  const original = process.env.GATEWAY_ENCRYPTION_KEY;

  afterEach(() => {
    // Restore whatever the surrounding env had so other suites are unaffected.
    if (original === undefined) delete process.env.GATEWAY_ENCRYPTION_KEY;
    else process.env.GATEWAY_ENCRYPTION_KEY = original;
  });

  it('round-trips a secret: decryptSecret(encryptSecret(x)) === x', () => {
    process.env.GATEWAY_ENCRYPTION_KEY = VALID_KEY;
    const secret = 'sk-abcdef, this is a provider key AB12';
    const packed = encryptSecret(secret);

    expect(Buffer.isBuffer(packed)).toBe(true);
    // iv(12) + tag(16) = 28 bytes of framing before the ciphertext.
    expect(packed.length).toBeGreaterThan(28);
    // The plaintext must not appear anywhere in the encrypted bytes.
    expect(packed.toString('utf8')).not.toContain('sk-abcdef');

    expect(decryptSecret(packed)).toBe(secret);
  });

  it('throws when the ciphertext (auth tag) is tampered with', () => {
    process.env.GATEWAY_ENCRYPTION_KEY = VALID_KEY;
    const packed = encryptSecret('sk-tamper-me');
    // Flip a byte inside the auth tag region (bytes 12..28).
    packed[20] = packed[20] ^ 0xff;

    expect(() => decryptSecret(packed)).toThrow();
  });

  it('encryptSecret throws when GATEWAY_ENCRYPTION_KEY is not set', () => {
    delete process.env.GATEWAY_ENCRYPTION_KEY;
    expect(() => encryptSecret('sk-x')).toThrow('GATEWAY_ENCRYPTION_KEY is not set');
  });

  it('assertMasterKey throws when the key is the wrong length', () => {
    process.env.GATEWAY_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64'); // 16 bytes, too short
    expect(() => assertMasterKey()).toThrow('GATEWAY_ENCRYPTION_KEY must be 32 bytes (base64)');
  });
});
