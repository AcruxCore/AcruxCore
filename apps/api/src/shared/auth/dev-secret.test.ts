import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateDevSecret } from './dev-secret';

describe('loadOrCreateDevSecret', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acx-dev-secret-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an owner-only file on first use and returns the same value after a restart', () => {
    const file = join(dir, '.better-auth-dev-secret');
    const first = loadOrCreateDevSecret(file);

    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // What a `tsx watch` restart does: a new process reads the same file.
    expect(loadOrCreateDevSecret(file)).toBe(first);
  });

  it('gives each machine its own value', () => {
    const a = loadOrCreateDevSecret(join(dir, 'a'));
    const b = loadOrCreateDevSecret(join(dir, 'b'));
    expect(a).not.toBe(b);
  });

  it('replaces a file too short to be a secret', () => {
    const file = join(dir, '.better-auth-dev-secret');
    writeFileSync(file, 'short\n');
    const secret = loadOrCreateDevSecret(file);
    expect(secret).not.toBe('short');
    expect(readFileSync(file, 'utf8').trim()).toBe(secret);
  });

  it('falls back to a random per-process value when the file cannot be written', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const file = join(dir, 'missing-directory', '.better-auth-dev-secret');
      const a = loadOrCreateDevSecret(file);
      const b = loadOrCreateDevSecret(file);
      expect(a.length).toBeGreaterThanOrEqual(32);
      expect(a).not.toBe(b);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('BETTER_AUTH_SECRET'));
    } finally {
      warn.mockRestore();
    }
  });
});
