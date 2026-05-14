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
import type { ToolResolver } from './resolver.js';

const log = createLogger('ToolCallbackServer');

export class ToolCallbackServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly toolResolver: ToolResolver;

  /** Current request_id for tool calls (set by the bridge during request execution). */
  private currentRequestId: string | null = null;

  constructor(toolResolver: ToolResolver) {
    this.toolResolver = toolResolver;
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
   * Set the current request ID that tool calls will be associated with.
   */
  setCurrentRequestId(requestId: string | null): void {
    this.currentRequestId = requestId;
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

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
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
    let parsed: { tool_name: string; arguments: Record<string, unknown>; request_id?: string };

    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { tool_name, arguments: args } = parsed;
    const requestId = parsed.request_id ?? this.currentRequestId ?? 'unknown';
    const toolCallId = `tc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    log.debug('Tool call received via HTTP callback', { tool_name, toolCallId, requestId });

    try {
      // Route through the ToolResolver which sends over WebSocket and waits
      const result = await this.toolResolver.call(
        // The sendFn is a no-op here because the Bridge's actual send function
        // is not directly available. Instead, we use the resolver's existing
        // pending call mechanism, and the bridge wires up the actual WebSocket send.
        // For the callback server, we emit an event that the bridge can listen to.
        () => {
          // This is handled by the bridge wiring
        },
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
