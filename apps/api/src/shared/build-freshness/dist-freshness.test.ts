import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDistFreshness, formatStaleBuildWarning } from './dist-freshness';

/** Seconds since epoch for a fixed, ordered pair of timestamps. */
const OLD = new Date('2026-08-01T10:00:00.000Z');
const NEW = new Date('2026-08-01T12:00:00.000Z');

let root: string;

/** Writes a file, creating parents, and stamps its mtime. */
function write(rel: string, at: Date): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '// x');
  utimesSync(full, at, at);
  return full;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dist-freshness-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkDistFreshness', () => {
  it('reports stale when a source file is newer than the newest compiled file', () => {
    write('dist/src/gateway/gateway.service.js', OLD);
    write('src/gateway/gateway.service.ts', NEW);

    const f = checkDistFreshness(join(root, 'src'), join(root, 'dist'));

    expect(f.stale).toBe(true);
    expect(f.builtAt?.toISOString()).toBe(OLD.toISOString());
    expect(f.newestSrcAt?.toISOString()).toBe(NEW.toISOString());
    expect(f.staleFiles).toEqual(['gateway/gateway.service.ts']);
  });

  it('reports fresh when the build is newer than every source file', () => {
    write('src/gateway/gateway.service.ts', OLD);
    write('dist/src/gateway/gateway.service.js', NEW);

    const f = checkDistFreshness(join(root, 'src'), join(root, 'dist'));

    expect(f.stale).toBe(false);
    expect(f.staleFiles).toEqual([]);
  });

  it('reports stale when dist does not exist at all', () => {
    write('src/index.ts', NEW);

    const f = checkDistFreshness(join(root, 'src'), join(root, 'dist'));

    expect(f.stale).toBe(true);
    expect(f.builtAt).toBeNull();
  });

  it('ignores .test.ts files, so a red-green cycle never raises the alarm', () => {
    write('src/gateway/gateway.service.ts', OLD);
    write('dist/src/gateway/gateway.service.js', OLD);
    write('src/gateway/gateway.test.ts', NEW);

    const f = checkDistFreshness(join(root, 'src'), join(root, 'dist'));

    expect(f.stale).toBe(false);
  });

  it('is not stale when there is no source tree to compare', () => {
    write('dist/src/index.js', OLD);

    const f = checkDistFreshness(join(root, 'src'), join(root, 'dist'));

    expect(f.stale).toBe(false);
    expect(f.newestSrcAt).toBeNull();
  });
});

describe('formatStaleBuildWarning', () => {
  it('names the build command and the offending sources when stale', () => {
    write('dist/src/a.js', OLD);
    write('src/a.ts', NEW);

    const banner = formatStaleBuildWarning(
      checkDistFreshness(join(root, 'src'), join(root, 'dist')),
      'apps/api',
      'npm run build -w @acruxcore/api',
    );

    expect(banner).toContain('STALE BUILD');
    expect(banner).toContain('npm run build -w @acruxcore/api');
    expect(banner).toContain('a.ts');
  });

  it('returns null when the build is fresh, so a healthy boot stays quiet', () => {
    write('src/a.ts', OLD);
    write('dist/src/a.js', NEW);

    expect(
      formatStaleBuildWarning(
        checkDistFreshness(join(root, 'src'), join(root, 'dist')),
        'apps/api',
        'npm run build',
      ),
    ).toBeNull();
  });
});
