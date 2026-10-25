import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadClaudeToken, parseClaudeEnv } from '../../src/providers/claude-token.js';

/**
 * A bridge installed as a service on a server nobody signs into: Claude has to
 * get its long-lived token (claude setup-token) from somewhere, and before this
 * the service had none, so every turn answered "Not logged in".
 */
describe('the long-lived Claude token', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-token-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const file = (text: string, mode = 0o600): string => {
    const path = join(dir, 'claude.env');
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  };

  test('is read from its file into the environment Claude inherits', () => {
    const env: NodeJS.ProcessEnv = {};
    const outcome = loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n'), env);
    expect(outcome.status).toBe('loaded');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-abc');
  });

  test('accepts the shapes people write a file they also source in', () => {
    expect(parseClaudeEnv('# made 2026-10-25\nexport CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-x"\n')).toBe('sk-ant-oat01-x');
    expect(parseClaudeEnv("CLAUDE_CODE_OAUTH_TOKEN='y'")).toBe('y');
    expect(parseClaudeEnv('OTHER=1\n')).toBeNull();
    expect(parseClaudeEnv('CLAUDE_CODE_OAUTH_TOKEN=\n')).toBeNull();
  });

  test('a token already in the environment wins, so one run can override it', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' };
    expect(loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN=from-file\n'), env).status).toBe('already_set');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('from-env');
  });

  test.skipIf(process.platform === 'win32')('a file others can read is refused, not used', () => {
    const env: NodeJS.ProcessEnv = {};
    const outcome = loadClaudeToken(file('CLAUDE_CODE_OAUTH_TOKEN=t\n', 0o644), env);
    expect(outcome).toMatchObject({ status: 'too_open', mode: '644' });
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  test('a missing file or one without the line says so instead of failing quietly', () => {
    expect(loadClaudeToken(join(dir, 'nope.env'), {}).status).toBe('unreadable');
    expect(loadClaudeToken(file('SOMETHING=else\n'), {}).status).toBe('no_token');
  });
});

test('nothing in src passes arguments to a shell (DEP0190 on Node 24)', () => {
  // `execFileSync(cmd, args, { shell: true })` concatenates args unescaped,
  // and Node 24 prints a deprecation warning in the middle of every install.
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []);
  const offenders = walk(join(__dirname, '..', '..', 'src')).filter((f) => /shell:\s*true/.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});
