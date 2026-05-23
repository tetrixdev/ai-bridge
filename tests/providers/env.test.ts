import { describe, it, expect } from 'vitest';
import {
  buildSpawnEnv,
  buildCombinedPrompt,
  appendStderr,
  formatStderrMessage,
  resolveSystemPrompt,
  ISOLATED_FALLBACK_SYSTEM_PROMPT,
} from '../../src/providers/env.js';

describe('Environment Utilities', () => {
  describe('buildSpawnEnv()', () => {
    it('does not modify PATH (the legacy toolScriptDir PATH-prepend was removed in favour of MCP)', () => {
      const originalPath = process.env['PATH'];
      const env = buildSpawnEnv();

      expect(env['PATH']).toBe(originalPath);
    });

    it('sets AI_BRIDGE_REQUEST_ID when requestId is provided', () => {
      const env = buildSpawnEnv('req-abc-123');

      expect(env['AI_BRIDGE_REQUEST_ID']).toBe('req-abc-123');
    });

    it('does not set AI_BRIDGE_REQUEST_ID when requestId is omitted', () => {
      // Clear any existing value
      const originalReqId = process.env['AI_BRIDGE_REQUEST_ID'];
      delete process.env['AI_BRIDGE_REQUEST_ID'];

      const env = buildSpawnEnv();
      expect(env['AI_BRIDGE_REQUEST_ID']).toBeUndefined();

      // Restore
      if (originalReqId !== undefined) {
        process.env['AI_BRIDGE_REQUEST_ID'] = originalReqId;
      }
    });

    it('merges extra env entries on top of process.env', () => {
      const env = buildSpawnEnv('req-xyz', { AI_BRIDGE_MCP_TOKEN: 'tok' });

      expect(env['AI_BRIDGE_REQUEST_ID']).toBe('req-xyz');
      expect(env['AI_BRIDGE_MCP_TOKEN']).toBe('tok');
    });

    it('strips bridge credential vars (AI_BRIDGE_TOKEN, AI_BRIDGE_SERVER) from child env', () => {
      const originalToken = process.env['AI_BRIDGE_TOKEN'];
      const originalServer = process.env['AI_BRIDGE_SERVER'];
      process.env['AI_BRIDGE_TOKEN'] = 'parent-secret';
      process.env['AI_BRIDGE_SERVER'] = 'wss://example';

      const env = buildSpawnEnv();
      expect(env['AI_BRIDGE_TOKEN']).toBeUndefined();
      expect(env['AI_BRIDGE_SERVER']).toBeUndefined();

      // Restore
      if (originalToken !== undefined) process.env['AI_BRIDGE_TOKEN'] = originalToken;
      else delete process.env['AI_BRIDGE_TOKEN'];
      if (originalServer !== undefined) process.env['AI_BRIDGE_SERVER'] = originalServer;
      else delete process.env['AI_BRIDGE_SERVER'];
    });

    it('returns a copy of process.env, not the original', () => {
      const env = buildSpawnEnv();

      env['MY_CUSTOM_VAR'] = 'test';
      expect(process.env['MY_CUSTOM_VAR']).toBeUndefined();
    });
  });

  describe('resolveSystemPrompt()', () => {
    it('returns the server-supplied prompt when present in isolated mode', () => {
      expect(resolveSystemPrompt('be helpful', 'isolated')).toBe('be helpful');
    });

    it('returns the server-supplied prompt when present in native mode', () => {
      expect(resolveSystemPrompt('be helpful', 'native')).toBe('be helpful');
    });

    it('returns the neutral fallback in isolated mode when the server did not send one', () => {
      expect(resolveSystemPrompt(null, 'isolated')).toBe(ISOLATED_FALLBACK_SYSTEM_PROMPT);
    });

    it('returns null in native mode when the server did not send one (CLI uses its own default)', () => {
      expect(resolveSystemPrompt(null, 'native')).toBeNull();
    });

    it('treats empty string the same as null (falsy → fallback)', () => {
      // The bridge gets the server-side string verbatim — an empty value means
      // "nothing supplied" from the model's point of view, so fall through.
      expect(resolveSystemPrompt('', 'isolated')).toBe(ISOLATED_FALLBACK_SYSTEM_PROMPT);
      expect(resolveSystemPrompt('', 'native')).toBeNull();
    });
  });

  describe('buildCombinedPrompt()', () => {
    it('formats system prompt and user message correctly', () => {
      const result = buildCombinedPrompt('You are a helpful assistant.', 'What is 2+2?');

      expect(result).toBe('You are a helpful assistant.\n\nUser request:\nWhat is 2+2?');
    });

    it('handles empty system prompt', () => {
      const result = buildCombinedPrompt('', 'Hello');

      expect(result).toBe('\n\nUser request:\nHello');
    });

    it('handles empty user message', () => {
      const result = buildCombinedPrompt('System prompt', '');

      expect(result).toBe('System prompt\n\nUser request:\n');
    });

    it('handles multi-line system prompt', () => {
      const systemPrompt = 'Line 1\nLine 2\nLine 3';
      const result = buildCombinedPrompt(systemPrompt, 'Go');

      expect(result).toContain('Line 1\nLine 2\nLine 3');
      expect(result).toContain('User request:\nGo');
    });

    it('handles multi-line user message', () => {
      const result = buildCombinedPrompt('System', 'Line A\nLine B');

      expect(result).toBe('System\n\nUser request:\nLine A\nLine B');
    });
  });

  describe('appendStderr()', () => {
    it('appends chunk to buffer', () => {
      const result = appendStderr('hello ', 'world');
      expect(result).toBe('hello world');
    });

    it('returns chunk when buffer is empty', () => {
      const result = appendStderr('', 'first chunk');
      expect(result).toBe('first chunk');
    });

    it('caps at MAX_STDERR_SIZE (10KB) keeping the first 10KB', () => {
      const maxSize = 10 * 1024;
      const existing = 'x'.repeat(maxSize - 10);
      const overflow = 'y'.repeat(100);

      const result = appendStderr(existing, overflow);

      // keeps first 10KB (not last), so result ends with first 10 chars of overflow
      expect(result.length).toBe(maxSize);
      expect(result.startsWith('x'.repeat(maxSize - 10))).toBe(true);
      expect(result.endsWith('y'.repeat(10))).toBe(true);
    });

    it('stops accumulating once buffer is at max size', () => {
      const maxSize = 10 * 1024;
      // Fill the buffer to exactly max size
      const buffer = 'A'.repeat(maxSize);
      const chunk = 'B'.repeat(100);

      const result = appendStderr(buffer, chunk);

      // Buffer is already full — new chunk is ignored
      expect(result.length).toBe(maxSize);
      expect(result.startsWith('A')).toBe(true);
      expect(result.endsWith('A')).toBe(true);
    });

    it('handles buffer already at max size (no new content)', () => {
      const maxSize = 10 * 1024;
      const buffer = 'A'.repeat(maxSize);
      const chunk = 'B'.repeat(50);

      const result = appendStderr(buffer, chunk);

      expect(result.length).toBe(maxSize);
      // Buffer was full — new chunk discarded
      expect(result.endsWith('A')).toBe(true);
    });

    it('does not truncate when total is under limit', () => {
      const result = appendStderr('short', ' text');
      expect(result).toBe('short text');
      expect(result.length).toBeLessThan(10 * 1024);
    });
  });

  describe('formatStderrMessage()', () => {
    it('returns auth guidance for stderr containing "401"', () => {
      const msg = formatStderrMessage('claude', 'Request failed with status code 401\nrun claude auth login', 1);
      expect(msg).toContain('Authentication required');
      expect(msg).toContain('claude auth login');
    });

    it('returns auth guidance for stderr containing "auth"', () => {
      const msg = formatStderrMessage('claude', 'Error: Not authenticated. Please run: claude auth', 1);
      expect(msg).toContain('Authentication required');
    });

    it('returns auth guidance for stderr containing "login"', () => {
      const msg = formatStderrMessage('codex', 'Please login first', 1);
      expect(msg).toContain('Authentication required');
    });

    it('uses provider-specific auth command for codex (codex login)', () => {
      const msg = formatStderrMessage('codex', 'Error: 401 Unauthorized', 1);
      expect(msg).toContain('codex login');
      expect(msg).not.toContain('codex auth login');
    });

    it('uses provider-specific auth command for claude (claude auth login)', () => {
      const msg = formatStderrMessage('claude', 'Error: 401 Unauthorized', 1);
      expect(msg).toContain('claude auth login');
    });

    it('uses provider-specific auth command for gemini (gemini auth login)', () => {
      const msg = formatStderrMessage('gemini', 'Error: 401 Unauthorized', 1);
      expect(msg).toContain('gemini auth login');
    });

    it('returns rate limit guidance for "rate limit" in stderr', () => {
      const msg = formatStderrMessage('gemini', 'Error: rate limit exceeded', 1);
      expect(msg).toContain('Rate limit');
    });

    it('returns rate limit guidance for "429" in stderr', () => {
      const msg = formatStderrMessage('codex', 'HTTP 429 Too Many Requests', 1);
      expect(msg).toContain('Rate limit');
    });

    it('strips ANSI escape codes from raw stderr', () => {
      const msg = formatStderrMessage('claude', '\x1b[31mSome error occurred\x1b[0m', 1);
      expect(msg).not.toContain('\x1b');
      expect(msg).toContain('Some error occurred');
    });

    it('returns first non-empty line for unrecognized errors', () => {
      const msg = formatStderrMessage('gemini', 'Unknown error\nsome stack trace\nmore details', 1);
      expect(msg).toBe('Unknown error');
    });

    it('returns generic message for empty stderr', () => {
      const msg = formatStderrMessage('claude', '', 1);
      expect(msg).toContain('exited with code 1');
    });

    it('truncates very long unrecognized messages to 500 chars', () => {
      const long = 'X'.repeat(600);
      const msg = formatStderrMessage('claude', long, 1);
      expect(msg.length).toBeLessThanOrEqual(500);
    });
  });
});
