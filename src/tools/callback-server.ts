/**
 * Tool Callback Server
 *
 * A minimal local HTTP server that tool wrapper scripts POST to
 * when a CLI invokes a tool. The server receives the tool call,
 * routes it through the ToolResolver (which sends it over WebSocket
 * to the server and waits for the result), then responds to the
 * HTTP request with the tool result.
 *
 * Flow:
 *   1. CLI invokes bash wrapper script for a tool
 *   2. Script POSTs to http://127.0.0.1:<port>/tool-call
 *   3. This server receives the request
 *   4. Routes through ToolResolver -> WebSocket -> server -> tool_resolve
 *   5. Returns the result to the bash script via HTTP response
 *   6. Bash script prints result to stdout for CLI to consume
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type { ToolResolver, SendToolCallFn } from './resolver.js';

const log = createLogger('ToolCallbackServer');

/** Maximum request body size: 1 MB. */
const MAX_BODY_SIZE = 1048576;

export class ToolCallbackServer {
  private server: http.Server | null = null;
  private port: number | null = null;

  /** Set of registered tool names for validation (SEC-001). */
  private registeredToolNames: Set<string> | null = null;

  /** SEC-002: Shared secret for authenticating callback requests. */
  private readonly secret: string | null;

  constructor(
    private readonly toolResolver: ToolResolver,
    private readonly sendFn: SendToolCallFn,
    registeredToolNames?: Set<string>,
    secret?: string,
  ) {
    if (registeredToolNames) {
      this.registeredToolNames = registeredToolNames;
    }
    this.secret = secret ?? null;
  }

  /**
   * Set the registered tool names for validation.
   * Tool calls with names not in this set will be rejected.
   */
  setRegisteredToolNames(names: Set<string>): void {
    this.registeredToolNames = names;
  }

  /**
   * Start the local HTTP server on a random available port.
   */
  async start(): Promise<number> {
    if (this.server) {
      return this.port!;
    }

    return new Promise<number>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Listen on random port, only on localhost
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          log.info('Tool callback server started', { port: this.port });
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (err) => {
        log.error('Tool callback server error', { error: err.message });
        reject(err);
      });
    });
  }

  /**
   * Stop the callback server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        log.info('Tool callback server stopped');
        this.server = null;
        this.port = null;
        resolve();
      });
    });
  }

  /**
   * Get the port the server is listening on, or null if not started.
   */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Handle incoming HTTP requests from tool wrapper scripts.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/tool-call') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // SEC-002: Verify bearer token if a secret is configured
    if (this.secret) {
      const authHeader = req.headers['authorization'];
      if (!authHeader || authHeader !== `Bearer ${this.secret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // BL-030: Enforce body size limit
    let body = '';
    let bodyLength = 0;

    req.on('data', (chunk: Buffer) => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      // If the request was already destroyed due to size limit, skip processing
      if (bodyLength > MAX_BODY_SIZE) return;

      this.processToolCall(body, res).catch((err) => {
        log.error('Failed to process tool call', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
    });
  }

  private async processToolCall(body: string, res: http.ServerResponse): Promise<void> {
    let parsed: { tool_name: string; tool_call_id?: string; arguments: Record<string, unknown>; request_id?: string };

    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { tool_name, arguments: args } = parsed;

    // ARCH-001 / UX-006 / EFF-008: request_id comes exclusively from POST body
    const requestId = parsed.request_id;
    if (!requestId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing request_id \u2014 tool call cannot be routed' }));
      return;
    }

    // SEC-001: Validate tool_name against registered set
    if (this.registeredToolNames && !this.registeredToolNames.has(tool_name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown tool: ${tool_name}` }));
      return;
    }

    const toolCallId = `tc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    log.debug('Tool call received via HTTP callback', { tool_name, toolCallId, requestId });

    try {
      // Route through the ToolResolver which sends over WebSocket and waits
      const result = await this.toolResolver.call(
        this.sendFn,
        requestId,
        toolCallId,
        tool_name,
        args ?? {},
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: typeof result === 'string' ? result : JSON.stringify(result) }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  }
}
