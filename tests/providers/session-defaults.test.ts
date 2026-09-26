/**
 * Bridge-owned session defaults: the environment a turn's CLI is spawned with,
 * and the lifecycle addendum that describes it.
 *
 * The property worth protecting here is not that any particular flag is set —
 * it is that the addendum and the environment cannot disagree. A turn that runs
 * with background work enabled while its own instructions say the capability is
 * gone produces a model that has been lied to about something it can observe
 * directly, and no test of either half alone would catch it.
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  BRIDGE_ENV_KEYS,
  MAX_BRIDGE_PROMPT_BYTES,
  buildBridgeAddendum,
  buildSpawnEnv,
  joinSystemPrompt,
  resolveBridgeAddendum,
  resolveBridgeEnv,
  validateBridgePrompt,
} from '../../src/providers/env.js';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

const BACKGROUND = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';

describe('resolveBridgeEnv()', () => {
  it('disables background work by default', () => {
    expect(resolveBridgeEnv().values[BACKGROUND]).toBe('1');
  });

  it('disables auto-memory by default, so notes do not cross between projects', () => {
    expect(resolveBridgeEnv().values['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1');
  });

  it('leaves fork-subagent unset, so nothing is changed unasked', () => {
    const { values } = resolveBridgeEnv();

    // Present in the allow-list (a server MAY set it) but carrying no
    // default — the distinction that keeps an opinion available without
    // imposing it. The bridge has no architectural or privacy reason for this
    // one, and it changes cost for every project that never asked.
    expect(BRIDGE_ENV_KEYS['CLAUDE_CODE_FORK_SUBAGENT']).toBeDefined();
    expect(values['CLAUDE_CODE_FORK_SUBAGENT']).toBeUndefined();
  });

  it('lets a project turn memory back on for itself', () => {
    expect(
      resolveBridgeEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: null }).values[
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY'
      ],
    ).toBeNull();
  });

  it('lets a project override an allow-listed key', () => {
    const { values, overridden } = resolveBridgeEnv({ [BACKGROUND]: '0' });

    expect(values[BACKGROUND]).toBe('0');
    expect(overridden).toEqual([BACKGROUND]);
  });

  it('treats null and empty string as "unset", not as a value', () => {
    expect(resolveBridgeEnv({ [BACKGROUND]: null }).values[BACKGROUND]).toBeNull();
    expect(resolveBridgeEnv({ [BACKGROUND]: '' }).values[BACKGROUND]).toBeNull();
  });

  it('drops a key it does not allow, and names it rather than failing the turn', () => {
    const { values, rejected, overridden } = resolveBridgeEnv({
      PATH: '/tmp/evil',
      ANTHROPIC_BASE_URL: 'http://attacker',
    });

    expect(values['PATH']).toBeUndefined();
    expect(values['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(rejected).toEqual(['PATH', 'ANTHROPIC_BASE_URL']);
    expect(overridden).toEqual([]);
    // Still a usable turn: the defaults survived the rejected keys.
    expect(values[BACKGROUND]).toBe('1');
  });
});

describe('buildSpawnEnv() unsetting', () => {
  it('deletes a key rather than setting it to empty, which every CLI reads as set', () => {
    process.env['AI_BRIDGE_SPAWN_FIXTURE'] = 'inherited';
    try {
      const env = buildSpawnEnv(undefined, { AI_BRIDGE_SPAWN_FIXTURE: null });

      expect('AI_BRIDGE_SPAWN_FIXTURE' in env).toBe(false);
      expect(env['AI_BRIDGE_SPAWN_FIXTURE']).toBeUndefined();
    } finally {
      delete process.env['AI_BRIDGE_SPAWN_FIXTURE'];
    }
  });
});

describe('buildBridgeAddendum()', () => {
  it('always states the lifecycle, whatever the configuration', () => {
    const configurations: Record<string, string | null>[] = [
      { [BACKGROUND]: '1' },
      { [BACKGROUND]: '0' },
      {},
    ];
    for (const values of configurations) {
      expect(buildBridgeAddendum(values)).toContain('exits the moment your turn ends');
    }
  });

  it('says background work is disabled when it is', () => {
    const text = buildBridgeAddendum(resolveBridgeEnv().values);

    expect(text).toContain('Background shell commands are disabled');
    expect(text).toContain('nohup');
  });

  it('does NOT claim background work is disabled once a project turns it back on', () => {
    // The coupling this whole design exists for: the addendum is generated
    // from the environment the turn actually gets. A fixed string here would
    // contradict a capability the model can see in its own tool schema.
    const values = resolveBridgeEnv({ [BACKGROUND]: '0' }).values;
    const text = buildBridgeAddendum(values);

    expect(text).not.toContain('Background shell commands are disabled');
    expect(text).toContain('they still die with');
  });

  it('keeps the subagent and timeout guidance in both configurations', () => {
    for (const raw of ['1', '0']) {
      const text = buildBridgeAddendum(resolveBridgeEnv({ [BACKGROUND]: raw }).values);
      expect(text).toContain('Subagents are the exception');
      expect(text).toContain('bounded by its timeout');
    }
  });
});

describe('a turn that keeps its input open (accepts_input)', () => {
  it('drops the background-tasks default for that turn only', () => {
    // Unset (null), not merely absent: an inherited value in the bridge's own
    // environment has to be removed too, or the turn would still run with it.
    expect(resolveBridgeEnv(undefined, { acceptsInput: true }).values[BACKGROUND]).toBeNull();
    expect(resolveBridgeEnv(undefined, { acceptsInput: false }).values[BACKGROUND]).toBe('1');
    expect(resolveBridgeEnv().values[BACKGROUND]).toBe('1');
  });

  it('keeps every other default', () => {
    expect(resolveBridgeEnv(undefined, { acceptsInput: true }).values['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1');
  });

  it("still lets the server's explicit value win", () => {
    const { values, overridden } = resolveBridgeEnv({ [BACKGROUND]: '1' }, { acceptsInput: true });

    expect(values[BACKGROUND]).toBe('1');
    expect(overridden).toEqual([BACKGROUND]);
  });

  it('removes an inherited value from the spawned environment', () => {
    process.env[BACKGROUND] = '1';
    try {
      const env = buildSpawnEnv(undefined, resolveBridgeEnv(undefined, { acceptsInput: true }).values);
      expect(BACKGROUND in env).toBe(false);
    } finally {
      delete process.env[BACKGROUND];
    }
  });

  it('tells the model background tasks are available, reported when they fail, and can be re-run', () => {
    const values = resolveBridgeEnv(undefined, { acceptsInput: true }).values;
    const text = buildBridgeAddendum(values, { acceptsInput: true });

    expect(text).toContain('Background tasks are available in this turn');
    expect(text).toContain('fails or is stopped is reported to you');
    expect(text).toContain('re-run the task');
    // No longer claims one process per message: messages arrive in this one.
    expect(text).not.toContain('separate CLI process');
    expect(text).toContain('further messages while it runs');
    expect(text).not.toContain('Background shell commands are disabled');
  });

  it('still forbids detaching work from the turn, in every mode', () => {
    const modes: Array<[Record<string, string | null> | undefined, boolean]> = [
      [undefined, true], [undefined, false], [{ [BACKGROUND]: '0' }, false], [{ [BACKGROUND]: '1' }, true],
    ];
    for (const [overrides, acceptsInput] of modes) {
      const text = buildBridgeAddendum(resolveBridgeEnv(overrides, { acceptsInput }).values, { acceptsInput });
      for (const word of ['nohup', '`&`', 'disown', 'setsid']) {
        expect(text).toContain(word);
      }
    }
  });

  it('does not claim background tasks are on when the server turned them off for the turn', () => {
    const values = resolveBridgeEnv({ [BACKGROUND]: '1' }, { acceptsInput: true }).values;
    const text = buildBridgeAddendum(values, { acceptsInput: true });

    expect(text).not.toContain('Background tasks are available');
    expect(text).toContain('Background shell commands are disabled here');
  });

  it('leaves the addendum of every other turn exactly as it was', () => {
    const values = resolveBridgeEnv().values;

    expect(buildBridgeAddendum(values, { acceptsInput: false })).toBe(buildBridgeAddendum(values));
    expect(resolveBridgeAddendum(undefined, values, {}).text).toBe(buildBridgeAddendum(values));
  });

  it('carries the input-turn addendum through resolveBridgeAddendum', () => {
    const values = resolveBridgeEnv(undefined, { acceptsInput: true }).values;
    const resolved = resolveBridgeAddendum({ mode: 'append', text: 'Answer in Dutch.' }, values, { acceptsInput: true });

    expect(resolved.text).toContain('Background tasks are available in this turn');
    expect(resolved.text!.endsWith('Answer in Dutch.')).toBe(true);
  });
});

describe('validateBridgePrompt()', () => {
  it('accepts an absent spec — the common case needs no field at all', () => {
    expect(validateBridgePrompt(undefined)).toBeNull();
    expect(validateBridgePrompt(null)).toBeNull();
    expect(validateBridgePrompt({})).toBeNull();
  });

  it.each([
    ['default', undefined, null],
    ['off', undefined, null],
    ['append', 'project rules', null],
    ['replace', 'project rules', null],
  ] as const)('accepts mode %s', (mode, text, expected) => {
    expect(validateBridgePrompt({ mode, text })).toBe(expected);
  });

  it.each(['default', 'off'] as const)(
    'refuses text with mode %s, which would be silently discarded',
    (mode) => {
      expect(validateBridgePrompt({ mode, text: 'x' })).toMatch(/not allowed/);
    },
  );

  it.each(['append', 'replace'] as const)(
    'refuses mode %s with no text, which would silently mean something else',
    (mode) => {
      expect(validateBridgePrompt({ mode })).toMatch(/required/);
      expect(validateBridgePrompt({ mode, text: '' })).toMatch(/required/);
    },
  );

  it('refuses an unknown mode loudly instead of falling back to default', () => {
    expect(validateBridgePrompt({ mode: 'DEFAULT' as never })).toMatch(/must be one of/);
  });

  it('bounds the text, so an oversized prompt refuses instead of dying at spawn', () => {
    const text = 'x'.repeat(MAX_BRIDGE_PROMPT_BYTES + 1);

    expect(validateBridgePrompt({ mode: 'append', text })).toMatch(/exceeds/);
  });
});

describe('resolveBridgeAddendum()', () => {
  const values = resolveBridgeEnv().values;

  it('defaults to the bridge addendum alone', () => {
    const resolved = resolveBridgeAddendum(undefined, values);

    expect(resolved.mode).toBe('default');
    expect(resolved.text).toBe(buildBridgeAddendum(values));
    expect(resolved.serverText).toBe(false);
  });

  it('appends the project text after the addendum', () => {
    const resolved = resolveBridgeAddendum({ mode: 'append', text: 'Speak Dutch.' }, values);

    expect(resolved.text?.startsWith(buildBridgeAddendum(values))).toBe(true);
    expect(resolved.text).toContain('Speak Dutch.');
    expect(resolved.serverText).toBe(true);
  });

  it('replaces the addendum entirely when asked', () => {
    const resolved = resolveBridgeAddendum({ mode: 'replace', text: 'Only this.' }, values);

    expect(resolved.text).toBe('Only this.');
  });

  it('adds nothing at all with off', () => {
    expect(resolveBridgeAddendum({ mode: 'off' }, values).text).toBeNull();
  });
});

describe('joinSystemPrompt()', () => {
  it('returns null only when there is nothing to say', () => {
    expect(joinSystemPrompt(null, null)).toBeNull();
  });

  it('carries either half alone unchanged', () => {
    expect(joinSystemPrompt('server', null)).toBe('server');
    expect(joinSystemPrompt(null, 'bridge')).toBe('bridge');
  });

  it('puts the server first, because the bridge text is an addendum to it', () => {
    expect(joinSystemPrompt('server', 'bridge')).toBe('server\n\nbridge');
  });
});

describe('the Claude adapter, end to end', () => {
  /** Spawn the adapter against a no-op child and record what it was given. */
  async function launch(
    context: Partial<ExecutionContext>,
  ): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    const recorded: { args: string[]; env: NodeJS.ProcessEnv } = { args: [], env: {} };

    class Probe extends ClaudeAdapter {
      protected override spawnCli(
        _command: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        stdinInput?: string,
        cwd?: string,
      ): ChildProcessByStdio<Writable | null, Readable, Readable> {
        recorded.args = args;
        recorded.env = env;
        return spawn(process.execPath, ['-e', ''], {
          env,
          cwd,
          stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const request: AiRequestMessage = {
      type: 'ai_request',
      request_id: 'req_defaults',
      conversation_id: 'conv_1',
      provider: 'claude',
      message: 'do the thing',
      system_prompt: 'be useful',
      options: {},
      cli_session_id: null,
    };

    await new Probe().execute(
      {
        request,
        requestId: request.request_id,
        tools: [],
        mcp: null,
        cliIsolation: 'native',
        workingDir: process.cwd(),
        signal: new AbortController().signal,
        requestTimeoutSeconds: 30,
        silenceTimeoutSeconds: 0,
        cliSessionId: null,
        attachmentDir: null,
        bridgeEnv: {},
        bridgeAddendum: null,
        ...context,
      } as ExecutionContext,
      (_e: AdapterStreamEvent) => undefined,
    );

    return recorded;
  }

  it('passes the addendum beside the server prompt, not instead of it', async () => {
    const { args } = await launch({ bridgeAddendum: 'LIFECYCLE TEXT' });

    // Both flags, both values. Replacing --system-prompt with the append flag
    // would drag the CLI's own coding-agent persona back into a chat whose
    // prompt the server owns.
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('be useful');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('LIFECYCLE TEXT');
  });

  it('passes no append flag when the server took the lifecycle on itself', async () => {
    const { args } = await launch({ bridgeAddendum: null });

    expect(args).not.toContain('--append-system-prompt');
  });

  it('spawns with the resolved environment', async () => {
    const { env } = await launch({ bridgeEnv: resolveBridgeEnv().values });

    expect(env[BACKGROUND]).toBe('1');
  });

  it('honours an unset, so a project can turn a bridge default back off', async () => {
    process.env[BACKGROUND] = 'inherited-from-operator';
    try {
      const { env } = await launch({
        bridgeEnv: resolveBridgeEnv({ [BACKGROUND]: null }).values,
      });

      expect(BACKGROUND in env).toBe(false);
    } finally {
      delete process.env[BACKGROUND];
    }
  });
});
