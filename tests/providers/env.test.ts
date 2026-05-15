import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSpawnEnv, buildCombinedPrompt, appendStderr } from '../../src/providers/env.js';

describe('Environment Utilities', () => {
  describe('buildSpawnEnv()', () => {
    it('includes toolScriptDir at the beginning of PATH', () => {
      const env = buildSpawnEnv('/tmp/my-tools');

      expect(env['PATH']).toBeDefined();
      expect(env['PATH']!.startsWith('/tmp/my-tools:')).toBe(true);
    });

    it('preserves existing PATH when prepending toolScriptDir', () => {
      const originalPath = process.env['PATH'];
      const env = buildSpawnEnv('/tmp/tools');

      expect(env['PATH']).toBe(`/tmp/tools:${originalPath}`);
    });

    it('does not modify PATH when toolScriptDir is null', () => {
      const originalPath = process.env['PATH'];
      const env = buildSpawnEnv(null);

      expect(env['PATH']).toBe(originalPath);
    });

    it('sets AI_BRIDGE_REQUEST_ID when requestId is provided', () => {
      const env = buildSpawnEnv(null, 'req-abc-123');

      expect(env['AI_BRIDGE_REQUEST_ID']).toBe('req-abc-123');
    });

    it('does not set AI_BRIDGE_REQUEST_ID when requestId is omitted', () => {
      // Clear any existing value
      const originalReqId = process.env['AI_BRIDGE_REQUEST_ID'];
      delete process.env['AI_BRIDGE_REQUEST_ID'];

      const env = buildSpawnEnv(null);
      expect(env['AI_BRIDGE_REQUEST_ID']).toBeUndefined();

      // Restore
      if (originalReqId !== undefined) {
        process.env['AI_BRIDGE_REQUEST_ID'] = originalReqId;
      }
    });

    it('sets both PATH and AI_BRIDGE_REQUEST_ID together', () => {
      const env = buildSpawnEnv('/tmp/tools', 'req-xyz');

      expect(env['PATH']!.startsWith('/tmp/tools:')).toBe(true);
      expect(env['AI_BRIDGE_REQUEST_ID']).toBe('req-xyz');
    });

    it('returns a copy of process.env, not the original', () => {
      const env = buildSpawnEnv(null);

      env['MY_CUSTOM_VAR'] = 'test';
      expect(process.env['MY_CUSTOM_VAR']).toBeUndefined();
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

    it('caps at MAX_STDERR_SIZE (10KB)', () => {
      const maxSize = 10 * 1024;
      const existing = 'x'.repeat(maxSize - 10);
      const overflow = 'y'.repeat(100);

      const result = appendStderr(existing, overflow);

      expect(result.length).toBe(maxSize);
      // Should keep the tail end (last 10KB)
      expect(result.endsWith(overflow)).toBe(true);
    });

    it('truncates from the beginning when exceeding limit', () => {
      const maxSize = 10 * 1024;
      const buffer = 'A'.repeat(maxSize);
      const chunk = 'B'.repeat(100);

      const result = appendStderr(buffer, chunk);

      expect(result.length).toBe(maxSize);
      // Should end with the new chunk
      expect(result.endsWith(chunk)).toBe(true);
      // Should have lost some of the beginning
      expect(result.startsWith('A')).toBe(true);
    });

    it('handles buffer already at max size', () => {
      const maxSize = 10 * 1024;
      const buffer = 'A'.repeat(maxSize);
      const chunk = 'B'.repeat(50);

      const result = appendStderr(buffer, chunk);

      expect(result.length).toBe(maxSize);
      expect(result.endsWith(chunk)).toBe(true);
    });

    it('does not truncate when total is under limit', () => {
      const result = appendStderr('short', ' text');
      expect(result).toBe('short text');
      expect(result.length).toBeLessThan(10 * 1024);
    });
  });
});
