/**
 * Bridge-side HTTP MCP Server
 *
 * Replaces the legacy Bash-wrapper-on-PATH + prompt-manifest mechanism for
 * exposing server-registered tools to the spawned provider CLIs.
 *
 * Architecture:
 *
 *   Server (Laravel)
 *     ↑↓ WebSocket (existing tool_call / tool_resolve frames)
 *   Bridge process
 *     ├── BridgeMcpServer  ← in-process HTTP MCP server (this file)
 *     │     listens on 127.0.0.1:<random>, bearer-token authed
 *     │     exposes server-registered tools via `tools/list` and `tools/call`
 *     │     `tools/call` is routed through ToolResolver to the WS flow
 *     └── spawn CLI subprocess (codex/claude/gemini)
 *           configured to talk to this MCP server with a per-spawn token
 *           built-in shell / edit / autonomous-mode flags are NOT set, so
 *           the model can only invoke our MCP tools — no shell escape.
 *
 * Per-spawn tokens:
 *   Each AI request that launches a CLI gets a fresh token via issueToken();
 *   the bridge maps that token back to the request_id, so concurrent CLIs do
 *   not race on a single shared "active request" field. revokeToken() is
 *   called once the request completes so a stale CLI can't keep using its
 *   former bridge slot.
 *
 * Loopback-only by design: bound to 127.0.0.1 explicitly, never 0.0.0.0.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../protocol/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('McpServer');

/**
 * Callback invoked when the model calls one of our tools. `requestId` is the
 * AI request that owns the spawned CLI — resolved from the per-spawn token in
 * the inbound HTTP Authorization header, never null at call time (the request
 * handler refuses requests with unknown tokens before this fires).
 */
export type ToolCallHandler = (
  requestId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** AsyncLocalStorage payload — the request id resolved from the bearer token. */
interface McpCallContext {
  requestId: string;
}

/**
 * Bridge-side MCP server.
 *
 * Lifecycle:
 *   1. `new BridgeMcpServer(handleCall)` — wires up the SDK Server; nothing
 *      bound yet.
 *   2. `setTools(tools)` — call this whenever the server-registered tool set
 *      changes (welcome message, or future tools_update push).
 *   3. `start()` — opens an HTTP listener on `127.0.0.1:<random>`.
 *   4. `issueToken(requestId)` / `revokeToken(token)` — per-spawn token
 *      lifecycle. Each spawned CLI gets its own token; the bridge maps it
 *      back to the AI request that owns the spawn.
 *   5. `getBaseUrl()` — `http://127.0.0.1:<port>/mcp`, the value embedded in
 *      every CLI's MCP config.
 *   6. `stop()` — closes the HTTP listener.
 */
export class BridgeMcpServer {
  private httpServer: Server | null = null;
  private port: number | null = null;
  private tools: ToolDefinition[] = [];
  private readonly handleCall: ToolCallHandler;
  /** Per-spawn bearer tokens → AI request_id they map to. */
  private readonly tokens = new Map<string, string>();
  /** Propagates the resolved requestId from the HTTP handler down to the tool handler. */
  private readonly callContext = new AsyncLocalStorage<McpCallContext>();

  constructor(handleCall: ToolCallHandler) {
    this.handleCall = handleCall;
  }

  /**
   * Build a fresh per-request server + transport. The Streamable HTTP SDK is
   * designed to be instantiated per HTTP request in stateless mode — a single
   * shared transport survives only one client at a time, which would block
   * concurrent CLIs.
   */
  private buildPerRequestServer(): { server: McpServer; transport: StreamableHTTPServerTransport } {
    const server = new McpServer(
      { name: 'ai-bridge', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
      const ctx = this.callContext.getStore();
      log.info('MCP tools/list', {
        requestId: ctx?.requestId,
        toolCount: this.tools.length,
        tools: this.tools.map((t) => t.name),
      });
      return {
        tools: this.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: this.normalizeInputSchema(t.parameters),
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const ctx = this.callContext.getStore();

      if (!ctx) {
        log.error('MCP tools/call invoked without HTTP context — rejecting', { name });
        return {
          content: [{ type: 'text', text: 'Internal bridge error: no request context' }],
          isError: true,
        };
      }

      // INFO (not debug) so it shows up without --debug — live tests need to
      // see at-a-glance whether the CLI is actually reaching the MCP server.
      log.info('MCP tools/call', { requestId: ctx.requestId, name });

      try {
        const result = await this.handleCall(ctx.requestId, name, args);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        log.info('MCP tool resolved', {
          requestId: ctx.requestId,
          name,
          resultBytes: text.length,
        });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('MCP tool failed', { requestId: ctx.requestId, name, error: message });
        // isError: true tells the model the call failed without raising a
        // protocol-level error. The model can then recover (retry, ask the
        // user, give up gracefully) instead of seeing a hard JSON-RPC fault.
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    return { server, transport };
  }

  /**
   * Refresh the registered tools — called from the bridge whenever the welcome
   * message arrives (and would be called again if we ever add a mid-session
   * tools_update push).
   */
  setTools(tools: ToolDefinition[]): void {
    this.tools = tools;
    log.debug('MCP tool set updated', { count: tools.length });
  }

  /**
   * Open the HTTP listener.
   */
  async start(): Promise<void> {
    if (this.httpServer) {
      throw new Error('BridgeMcpServer already started');
    }

    this.httpServer = createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        log.error('Unhandled error in MCP HTTP handler', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      // Loopback only — never 0.0.0.0 even by accident, since this endpoint
      // is bearer-token-authed and not meant for off-host access.
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address() as AddressInfo;
        this.port = addr.port;
        resolve();
      });
    });

    log.info('Bridge MCP server listening', { url: this.getBaseUrl() });
  }

  /**
   * Close the HTTP listener.
   */
  async stop(): Promise<void> {
    if (!this.httpServer) {
      return;
    }
    const server = this.httpServer;
    this.httpServer = null;
    this.port = null;
    this.tokens.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    log.info('Bridge MCP server stopped');
  }

  /** True once start() has resolved and stop() has not been called. */
  isRunning(): boolean {
    return this.httpServer !== null;
  }

  /** Base URL CLIs connect to. Throws if start() has not been called. */
  getBaseUrl(): string {
    if (this.port === null) {
      throw new Error('BridgeMcpServer not started');
    }
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /**
   * Issue a fresh per-spawn bearer token for the given AI request id. The
   * caller embeds the returned token in the CLI's MCP config. Once the
   * request completes, the caller calls `revokeToken()` so the token can no
   * longer be used.
   */
  issueToken(requestId: string): string {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, requestId);
    return token;
  }

  /** Drop a per-spawn token. Idempotent. */
  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  /**
   * HTTP request handler — validates the bearer token, then forwards to the
   * MCP transport. The transport itself handles the JSON-RPC plumbing.
   */
  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the /mcp path is exposed.
    const url = req.url ?? '';
    if (!url.startsWith('/mcp')) {
      log.warn('MCP HTTP 404', { method: req.method, url });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    // Per-spawn bearer auth. The token maps back to the AI request that owns
    // this CLI, so two concurrent CLIs invoking the bridge MCP can both have
    // their tools/call frames routed to the right WS request_id.
    const auth = req.headers['authorization'] ?? '';
    const match = /^Bearer\s+(.+)$/.exec(auth);
    const token = match ? match[1] : null;
    const requestId = token ? this.tokens.get(token) : undefined;
    if (!token || !requestId) {
      // WARN (not debug) — a 401 here means either a CLI is misconfigured or
      // a per-spawn token was revoked before the CLI finished its turn.
      // Visible without --debug because it's actionable.
      log.warn('MCP HTTP 401 unauthorized', {
        method: req.method,
        hasBearer: !!token,
        tokenTail: token ? token.slice(-6) : null,
        knownTokens: this.tokens.size,
      });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Per-request server + transport (canonical stateless pattern). The
    // server and transport are torn down when the HTTP response closes.
    const { server, transport } = this.buildPerRequestServer();
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    await server.connect(transport);

    // Enter an AsyncLocalStorage frame keyed by this HTTP request — the
    // tools/call handler reads `requestId` from it without us having to
    // thread it through the SDK's request/response shape.
    await this.callContext.run({ requestId }, async () => {
      await transport.handleRequest(req, res);
    });
  }

  /**
   * Normalize a server-supplied JSON Schema into the shape MCP clients expect.
   *
   * Server tool definitions arrive as raw JSON Schema objects — the bridge
   * doesn't validate them. MCP's `inputSchema` field expects `type: "object"`
   * at the top level; if the server sent a schema that doesn't, wrap it.
   * Empty/null schemas become the no-parameter shape.
   */
  private normalizeInputSchema(
    parameters: Record<string, unknown> | undefined,
  ): { type: 'object'; properties?: Record<string, object>; required?: string[]; [k: string]: unknown } {
    if (!parameters || Object.keys(parameters).length === 0) {
      return { type: 'object', properties: {} };
    }
    if (parameters['type'] !== 'object') {
      // Best-effort wrap rather than rejecting — keeps the protocol forgiving.
      return {
        type: 'object',
        properties: parameters as Record<string, object>,
      };
    }
    return { ...(parameters as Record<string, unknown>), type: 'object' };
  }
}
