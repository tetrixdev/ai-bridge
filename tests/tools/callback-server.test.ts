import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { ToolCallbackServer } from '../../src/tools/callback-server.js';
import { ToolResolver } from '../../src/tools/resolver.js';
import type { SendToolCallFn } from '../../src/tools/resolver.js';

/**
 * Helper to make HTTP requests to the callback server.
 */
function makeRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/tool-call',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('ToolCallbackServer', () => {
  let resolver: ToolResolver;
  let sendFn: SendToolCallFn;
  let server: ToolCallbackServer;

  beforeEach(() => {
    resolver = new ToolResolver(30000);
    sendFn = vi.fn();
  });

  afterEach(async () => {
    resolver.cancelAll();
    if (server) {
      await server.stop();
    }
  });

  describe('start() and stop()', () => {
    it('starts an HTTP server on a random port', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      expect(port).toBeGreaterThan(0);
      expect(server.getPort()).toBe(port);
    });

    it('returns the same port if already started', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port1 = await server.start();
      const port2 = await server.start();

      expect(port1).toBe(port2);
    });

    it('stops the server', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      await server.start();
      await server.stop();

      expect(server.getPort()).toBeNull();
    });

    it('stop() is idempotent', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      await server.start();
      await server.stop();
      await server.stop(); // should not throw
    });
  });

  describe('request routing', () => {
    it('returns 404 for non-POST requests', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      const res = await makeRequest(port, { method: 'GET', path: '/tool-call' });
      expect(res.status).toBe(404);
    });

    it('returns 404 for wrong path', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      const res = await makeRequest(port, { path: '/wrong-path', body: '{}' });
      expect(res.status).toBe(404);
    });
  });

  describe('tool name validation', () => {
    it('rejects requests with unknown tool name', async () => {
      const toolNames = new Set(['allowedTool']);
      server = new ToolCallbackServer(resolver, sendFn, toolNames);
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'unknownTool',
        arguments: {},
        request_id: 'req-1',
      });
      const res = await makeRequest(port, { body });

      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toContain('Unknown tool');
    });

    it('accepts requests with registered tool name', async () => {
      const toolNames = new Set(['myTool']);

      // Use a promise that resolves when sendFn is first called instead of a
      // fixed-duration sleep, so this test is deterministic on slow CI runners.
      let resolveSendFnCalled!: (toolCallId: string) => void;
      const sendFnCalled = new Promise<string>((res) => { resolveSendFnCalled = res; });
      sendFn = vi.fn((_requestId: string, toolCallId: string) => {
        resolveSendFnCalled(toolCallId);
      }) as SendToolCallFn;

      server = new ToolCallbackServer(resolver, sendFn, toolNames);
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: { query: 'test' },
        request_id: 'req-1',
      });

      // The sendFn mock won't actually resolve, so the request will
      // hang until we manually resolve the tool call.
      const reqPromise = makeRequest(port, { body });

      // Wait until sendFn is invoked — event-driven, no fixed sleep
      const toolCallId = await sendFnCalled;

      // The sendFn should have been called (via resolver.call)
      expect(sendFn).toHaveBeenCalled();

      // Resolve the tool call
      resolver.resolve(toolCallId, 'tool result');

      const res = await reqPromise;
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.result).toBe('tool result');
    });

    it('setRegisteredToolNames() updates validation set', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      // Initially no restriction — set a restriction
      server.setRegisteredToolNames(new Set(['onlyThis']));

      const body = JSON.stringify({
        tool_name: 'otherTool',
        arguments: {},
        request_id: 'req-1',
      });
      const res = await makeRequest(port, { body });

      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain('Unknown tool');
    });
  });

  describe('request validation', () => {
    it('rejects invalid JSON', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      const res = await makeRequest(port, { body: 'not json{' });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain('Invalid JSON');
    });

    it('rejects requests without request_id', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: {},
        // no request_id
      });
      const res = await makeRequest(port, { body });

      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain('request_id');
    });
  });

  describe('body size limit', () => {
    it('rejects request bodies larger than 1MB', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      // Create a body larger than 1MB
      const largeBody = 'x'.repeat(1048577);

      const res = await makeRequest(port, { body: largeBody });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error).toContain('too large');
    });

    it('accepts request bodies under 1MB', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      // Large but under limit (needs to be valid JSON with request_id)
      const padding = 'x'.repeat(500000);
      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: { data: padding },
        request_id: 'req-1',
      });

      // This should not get 413
      const reqPromise = makeRequest(port, { body });

      // Wait for processing
      await new Promise((r) => setTimeout(r, 50));

      // Resolve the tool call
      if ((sendFn as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const callArgs = (sendFn as ReturnType<typeof vi.fn>).mock.calls[0];
        resolver.resolve(callArgs[1], 'ok');
      }

      const res = await reqPromise;
      expect(res.status).not.toBe(413);
    });
  });

  describe('secret authentication', () => {
    it('rejects requests without bearer token when secret is configured', async () => {
      server = new ToolCallbackServer(resolver, sendFn, undefined, 'my-secret');
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: {},
        request_id: 'req-1',
      });
      const res = await makeRequest(port, { body });

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).error).toContain('Unauthorized');
    });

    it('rejects requests with wrong bearer token', async () => {
      server = new ToolCallbackServer(resolver, sendFn, undefined, 'my-secret');
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: {},
        request_id: 'req-1',
      });
      const res = await makeRequest(port, {
        body,
        headers: { Authorization: 'Bearer wrong-secret' },
      });

      expect(res.status).toBe(401);
    });

    it('accepts requests with correct bearer token', async () => {
      server = new ToolCallbackServer(resolver, sendFn, undefined, 'my-secret');
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: {},
        request_id: 'req-1',
      });
      const reqPromise = makeRequest(port, {
        body,
        headers: { Authorization: 'Bearer my-secret' },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Resolve the tool call
      if ((sendFn as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const callArgs = (sendFn as ReturnType<typeof vi.fn>).mock.calls[0];
        resolver.resolve(callArgs[1], 'authenticated result');
      }

      const res = await reqPromise;
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).result).toBe('authenticated result');
    });

    it('does not require auth when no secret is configured', async () => {
      server = new ToolCallbackServer(resolver, sendFn);
      const port = await server.start();

      const body = JSON.stringify({
        tool_name: 'myTool',
        arguments: {},
        request_id: 'req-1',
      });
      const reqPromise = makeRequest(port, { body });

      await new Promise((r) => setTimeout(r, 50));

      if ((sendFn as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const callArgs = (sendFn as ReturnType<typeof vi.fn>).mock.calls[0];
        resolver.resolve(callArgs[1], 'no auth needed');
      }

      const res = await reqPromise;
      expect(res.status).toBe(200);
    });
  });
});
