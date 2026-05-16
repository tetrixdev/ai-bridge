import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

    // SEC-006: Case-insensitive denylist — capitalised variants must be rejected
    // to prevent shadowing system binaries on macOS (case-insensitive filesystem).
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
