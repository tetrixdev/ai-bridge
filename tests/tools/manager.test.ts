import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ToolManager } from '../../src/tools/manager.js';
import type { ToolDefinition } from '../../src/protocol/types.js';

describe('ToolManager', () => {
  let manager: ToolManager;

  beforeEach(() => {
    manager = new ToolManager();
  });

  afterEach(() => {
    manager.cleanupScripts();
  });

  describe('register()', () => {
    it('stores valid tools correctly', () => {
      const tools: ToolDefinition[] = [
        { name: 'myTool', description: 'A tool', parameters: {} },
        { name: 'another-tool', description: 'Another tool', parameters: { type: 'object' } },
      ];

      manager.register(tools);

      expect(manager.count()).toBe(2);
      expect(manager.get('myTool')).toEqual(tools[0]);
      expect(manager.get('another-tool')).toEqual(tools[1]);
    });

    it('replaces previously registered tools', () => {
      manager.register([{ name: 'toolA', description: 'first', parameters: {} }]);
      expect(manager.count()).toBe(1);

      manager.register([{ name: 'toolB', description: 'second', parameters: {} }]);
      expect(manager.count()).toBe(1);
      expect(manager.get('toolA')).toBeUndefined();
      expect(manager.get('toolB')).toBeDefined();
    });

    it('skips tools with invalid names but registers valid ones', () => {
      const tools: ToolDefinition[] = [
        { name: 'validTool', description: 'ok', parameters: {} },
        { name: '123invalid', description: 'bad', parameters: {} }, // starts with number
        { name: 'also_valid', description: 'ok', parameters: {} },
      ];

      manager.register(tools);

      expect(manager.count()).toBe(2);
      expect(manager.get('validTool')).toBeDefined();
      expect(manager.get('123invalid')).toBeUndefined();
      expect(manager.get('also_valid')).toBeDefined();
    });
  });

  describe('tool name validation', () => {
    it('accepts valid tool names', () => {
      const validNames = ['myTool', 'a', 'Tool_with-dashes', 'A123', 'abcdefghijklmnopqrstuvwxyz'];
      const tools = validNames.map((name) => ({ name, description: 'test', parameters: {} }));

      manager.register(tools);
      expect(manager.count()).toBe(validNames.length);
    });

    it('rejects names starting with a digit', () => {
      manager.register([{ name: '1tool', description: 'test', parameters: {} }]);
      expect(manager.count()).toBe(0);
    });

    it('rejects names with special characters', () => {
      const invalidNames = ['tool.name', 'tool/name', 'tool name', 'tool@name', '$tool'];
      const tools = invalidNames.map((name) => ({ name, description: 'test', parameters: {} }));

      manager.register(tools);
      expect(manager.count()).toBe(0);
    });

    it('rejects empty string name', () => {
      manager.register([{ name: '', description: 'test', parameters: {} }]);
      expect(manager.count()).toBe(0);
    });

    it('rejects names exceeding 64 characters', () => {
      const longName = 'a' + 'b'.repeat(64); // 65 chars total
      manager.register([{ name: longName, description: 'test', parameters: {} }]);
      expect(manager.count()).toBe(0);
    });

    it('accepts names exactly at 64 character limit', () => {
      const maxName = 'a' + 'b'.repeat(63); // 64 chars total
      manager.register([{ name: maxName, description: 'test', parameters: {} }]);
      expect(manager.count()).toBe(1);
    });
  });

  describe('reserved names', () => {
    it('rejects reserved system binary names', () => {
      const reservedNames = ['curl', 'bash', 'git', 'node', 'npm', 'python', 'ssh', 'sudo', 'rm', 'cat'];
      const tools = reservedNames.map((name) => ({ name, description: 'test', parameters: {} }));

      manager.register(tools);
      expect(manager.count()).toBe(0);
    });

    it('rejects all known reserved names', () => {
      const allReserved = [
        'curl', 'wget', 'node', 'npm', 'npx', 'bash', 'sh', 'zsh',
        'python', 'python3', 'ruby', 'perl', 'git', 'ssh', 'scp',
        'cat', 'ls', 'rm', 'cp', 'mv', 'chmod', 'chown', 'mkdir',
        'kill', 'ps', 'env', 'sudo', 'su', 'tar', 'gzip', 'gunzip',
        'openssl', 'nc', 'ncat', 'netcat', 'socat', 'find', 'grep',
        'awk', 'sed', 'echo', 'printf', 'head', 'tail', 'wc', 'tee',
        'test', 'true', 'false', 'xargs', 'sort', 'uniq', 'cut', 'tr',
        'make',
      ];
      const tools = allReserved.map((name) => ({ name, description: 'test', parameters: {} }));

      manager.register(tools);
      expect(manager.count()).toBe(0);
    });

    it('allows similar but non-reserved names', () => {
      const nonReserved = ['my-curl', 'git-helper', 'node-tool', 'bash-wrapper'];
      const tools = nonReserved.map((name) => ({ name, description: 'test', parameters: {} }));

      manager.register(tools);
      expect(manager.count()).toBe(nonReserved.length);
    });

    // Case-insensitive denylist — capitalised variants must be rejected to
    // prevent shadowing system binaries on case-insensitive filesystems (macOS).
    it('rejects reserved names with uppercase variants (SEC-006)', () => {
      const capitalised = ['Curl', 'BASH', 'Git', 'Node', 'Npm', 'Python', 'Sudo', 'RM', 'Cat'];
      const tools = capitalised.map((name) => ({ name, description: 'test', parameters: {} }));

      manager.register(tools);
      expect(manager.count()).toBe(0);
      expect(manager.getRejectedToolNames()).toHaveLength(capitalised.length);
    });

    it('rejects mixed-case reserved names', () => {
      manager.register([{ name: 'cUrL', description: 'test', parameters: {} }]);
      expect(manager.count()).toBe(0);
    });
  });

  describe('getRegisteredNames()', () => {
    it('returns an empty set when no tools are registered', () => {
      const names = manager.getRegisteredNames();
      expect(names).toBeInstanceOf(Set);
      expect(names.size).toBe(0);
    });

    it('returns the correct set of registered tool names', () => {
      manager.register([
        { name: 'toolA', description: 'A', parameters: {} },
        { name: 'toolB', description: 'B', parameters: {} },
        { name: 'toolC', description: 'C', parameters: {} },
      ]);

      const names = manager.getRegisteredNames();
      expect(names).toEqual(new Set(['toolA', 'toolB', 'toolC']));
    });
  });

  describe('generateScripts()', () => {
    it('creates scripts in a temp directory', () => {
      manager.register([
        { name: 'myTool', description: 'A tool', parameters: {} },
        { name: 'anotherTool', description: 'Another', parameters: {} },
      ]);

      const scriptDir = manager.generateScripts(9999);

      expect(fs.existsSync(scriptDir)).toBe(true);
      expect(fs.existsSync(path.join(scriptDir, 'myTool'))).toBe(true);
      expect(fs.existsSync(path.join(scriptDir, 'anotherTool'))).toBe(true);
    });

    it('generated scripts are executable', () => {
      manager.register([{ name: 'execTool', description: 'test', parameters: {} }]);

      const scriptDir = manager.generateScripts(9999);
      const stat = fs.statSync(path.join(scriptDir, 'execTool'));

      // Check that owner execute bit is set (mode & 0o100)
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it('generated scripts contain the tool name and port', () => {
      manager.register([{ name: 'searchTool', description: 'Search things', parameters: {} }]);

      const scriptDir = manager.generateScripts(12345);
      const content = fs.readFileSync(path.join(scriptDir, 'searchTool'), 'utf-8');

      expect(content).toContain('#!/usr/bin/env bash');
      expect(content).toContain('searchTool');
      expect(content).toContain('12345');
    });

    it('embeds the secret when provided', () => {
      manager.register([{ name: 'secretTool', description: 'test', parameters: {} }]);

      const scriptDir = manager.generateScripts(9999, 'my-secret-token');
      const content = fs.readFileSync(path.join(scriptDir, 'secretTool'), 'utf-8');

      expect(content).toContain('my-secret-token');
    });

    it('getScriptDir() returns the directory after generation', () => {
      manager.register([{ name: 'tool', description: 'test', parameters: {} }]);

      expect(manager.getScriptDir()).toBeNull();
      const dir = manager.generateScripts(9999);
      expect(manager.getScriptDir()).toBe(dir);
    });

    it('wrapper reads the payload from the first CLI argument', () => {
      manager.register([{ name: 'argTool', description: 'test', parameters: {} }]);

      const scriptDir = manager.generateScripts(9999);
      const content = fs.readFileSync(path.join(scriptDir, 'argTool'), 'utf-8');

      // The payload is taken from $1 when present and non-empty.
      expect(content).toContain('PAYLOAD_DATA="$1"');
      expect(content).toContain('"$#" -ge 1');
    });

    it('wrapper still falls back to stdin when no argument is given', () => {
      manager.register([{ name: 'stdinTool', description: 'test', parameters: {} }]);

      const scriptDir = manager.generateScripts(9999);
      const content = fs.readFileSync(path.join(scriptDir, 'stdinTool'), 'utf-8');

      // Stdin fallback: when not a TTY and no $1, read from cat.
      expect(content).toContain('elif [ ! -t 0 ]; then');
      expect(content).toContain('PAYLOAD_DATA=$(cat)');
      // The parsed payload is passed through to the node invocation.
      expect(content).toContain('"$PAYLOAD_DATA"');
    });

    it('wrapper keeps the JSON-parse + {input: ...} fallback', () => {
      manager.register([{ name: 'parseTool', description: 'test', parameters: {} }]);

      const scriptDir = manager.generateScripts(9999);
      const content = fs.readFileSync(path.join(scriptDir, 'parseTool'), 'utf-8');

      expect(content).toContain('JSON.parse(payloadData)');
      expect(content).toContain('{ input: payloadData }');
    });

    it('does not embed tool descriptions in the wrapper script', () => {
      manager.register([
        { name: 'descTool', description: 'SECRET-DESCRIPTION-MARKER', parameters: {} },
      ]);

      const scriptDir = manager.generateScripts(9999);
      const content = fs.readFileSync(path.join(scriptDir, 'descTool'), 'utf-8');

      expect(content).not.toContain('SECRET-DESCRIPTION-MARKER');
    });
  });

  describe('buildScript() payload behavior (integration)', () => {
    it('accepts a $1 argument without hanging on stdin', () => {
      manager.register([{ name: 'echoTool', description: 'test', parameters: {} }]);
      const scriptDir = manager.generateScripts(9999);
      const scriptPath = path.join(scriptDir, 'echoTool');

      // Invoke the wrapper with a JSON payload as $1.  With stdin redirected
      // from /dev/null and no callback server listening, the script exits 1
      // (Tool call failed) — but reaching that point proves $1 was consumed as
      // the payload and the script did not block waiting for stdin.
      const run = spawnSync('bash', [scriptPath, '{"x":1}'], {
        encoding: 'utf-8',
        input: '',
        timeout: 10_000,
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Tool call failed');
    });

    it('falls back to stdin when no $1 argument is given', () => {
      manager.register([{ name: 'stdinEchoTool', description: 'test', parameters: {} }]);
      const scriptDir = manager.generateScripts(9999);
      const scriptPath = path.join(scriptDir, 'stdinEchoTool');

      // No argument: the payload is read from stdin instead.  Again the call
      // fails to reach the bridge, proving the stdin path is still wired up.
      const run = spawnSync('bash', [scriptPath], {
        encoding: 'utf-8',
        input: '{"y":2}',
        timeout: 10_000,
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Tool call failed');
    });
  });

  describe('cleanupScripts()', () => {
    it('removes the temp directory', () => {
      manager.register([{ name: 'tool', description: 'test', parameters: {} }]);
      const dir = manager.generateScripts(9999);

      expect(fs.existsSync(dir)).toBe(true);
      manager.cleanupScripts();
      expect(fs.existsSync(dir)).toBe(false);
      expect(manager.getScriptDir()).toBeNull();
    });

    it('does nothing if no scripts have been generated', () => {
      expect(() => manager.cleanupScripts()).not.toThrow();
    });

    it('generateScripts() cleans up the previous directory', () => {
      manager.register([{ name: 'tool', description: 'test', parameters: {} }]);

      const dir1 = manager.generateScripts(9999);
      expect(fs.existsSync(dir1)).toBe(true);

      const dir2 = manager.generateScripts(8888);
      expect(fs.existsSync(dir1)).toBe(false);
      expect(fs.existsSync(dir2)).toBe(true);
    });
  });

  describe('get() / getAll()', () => {
    it('get() returns undefined for non-existent tool', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });

    it('get() returns the correct tool definition', () => {
      const tool: ToolDefinition = { name: 'myTool', description: 'My tool', parameters: { type: 'object' } };
      manager.register([tool]);

      expect(manager.get('myTool')).toEqual(tool);
    });

    it('getAll() returns an empty array when no tools are registered', () => {
      expect(manager.getAll()).toEqual([]);
    });

    it('getAll() returns all registered tool definitions', () => {
      const tools: ToolDefinition[] = [
        { name: 'toolA', description: 'A', parameters: {} },
        { name: 'toolB', description: 'B', parameters: {} },
      ];

      manager.register(tools);
      const all = manager.getAll();

      expect(all).toHaveLength(2);
      expect(all).toContainEqual(tools[0]);
      expect(all).toContainEqual(tools[1]);
    });
  });
});
