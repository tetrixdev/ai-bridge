/**
 * PROTOTYPE (branch proto/mcp-apps): MCP servers the bridge connects to itself
 * and offers to the CLI beside the server's tools, so the bridge sees each
 * tool DEFINITION, including MCP Apps' `_meta.ui.resourceUri` (ext-apps,
 * SEP-1865), and can serve the host (the web application) what a view needs:
 *
 *   - which call carries a view: the `ui` field on that call's tool_result
 *     stream event ({server, resource_uri, tool_name, arguments, result});
 *   - the view's document: `mcp_request` {method: "resources/read"};
 *   - the view's own calls back to its server: `mcp_request` {method: "tools/call"},
 *     refused for a tool whose visibility leaves out "app".
 *
 * Generic: nothing here knows any particular server. Configured by the person
 * running the bridge (`--mcp-upstreams <file>`, JSON `{"name": {"command",
 * "args", "env"} | {"url"}}`); a web application cannot add one.
 *
 * What the CLI gets back from a call is the text content only. A result's
 * structuredContent and _meta go to the host, not into the model's context
 * (Claude Code hands the model the JSON instead of the text when
 * structuredContent is present, and inlines an embedded HTML resource).
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '../protocol/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-upstream');

/** Between server and tool in the name the CLI sees: `<server>__<tool>`. */
export const UPSTREAM_SEPARATOR = '__';

export type UpstreamConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> };

interface UpstreamTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** What the host needs to draw a call's view, kept until its tool_result goes out. */
export interface CallUi {
  server: string;
  tool_name: string;
  resource_uri: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export function readUpstreamConfig(path: string): Record<string, UpstreamConfig> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, UpstreamConfig> } & Record<string, UpstreamConfig>;
  return (parsed.mcpServers ?? parsed) as Record<string, UpstreamConfig>;
}

function resourceUriOf(meta: unknown): string | null {
  const m = meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  const uri = m?.ui?.resourceUri ?? m?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

function visibility(meta: unknown): string[] {
  const v = (meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : ['model', 'app'];
}

export class UpstreamHub {
  private readonly clients = new Map<string, Client>();
  private tools: UpstreamTool[] = [];
  private readonly pendingUi = new Map<string, CallUi>();

  constructor(private readonly config: Record<string, UpstreamConfig>) {}

  get serverNames(): string[] {
    return [...this.clients.keys()];
  }

  /** Connect to every configured server. One that fails is logged and left out. */
  async start(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.config)) {
      if (!/^[a-z0-9_-]{1,32}$/i.test(name)) {
        log.warn('upstream name refused', { name });
        continue;
      }
      try {
        const client = new Client({ name: 'ai-bridge', version: '0.1.0' }, {
          capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } as never,
        });
        const transport = 'url' in cfg
          ? new StreamableHTTPClientTransport(new URL(cfg.url), cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined)
          : new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], ...(cfg.env ? { env: { ...process.env, ...cfg.env } as Record<string, string> } : {}), ...(cfg.cwd ? { cwd: cfg.cwd } : {}), stderr: 'ignore' });
        await client.connect(transport);
        const listed = await client.listTools();
        this.clients.set(name, client);
        for (const t of listed.tools) {
          this.tools.push({ server: name, name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, _meta: t._meta as Record<string, unknown> | undefined });
        }
        log.info('upstream MCP server connected', { name, tools: listed.tools.map((t) => t.name) });
      } catch (err) {
        log.warn('upstream MCP server failed to start', { name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** The tools the MODEL sees, namespaced. A tool only for its app ("visibility": ["app"]) is left out. */
  definitions(): ToolDefinition[] {
    return this.tools
      .filter((t) => visibility(t._meta).includes('model'))
      .map((t) => ({
        name: `${t.server}${UPSTREAM_SEPARATOR}${t.name}`,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        ...(t._meta ? { _meta: t._meta } : {}),
      }));
  }

  owns(qualified: string): boolean {
    return this.find(qualified) !== undefined;
  }

  private find(qualified: string): UpstreamTool | undefined {
    return this.tools.find((t) => `${t.server}${UPSTREAM_SEPARATOR}${t.name}` === qualified && visibility(t._meta).includes('model'));
  }

  /** A call from the CLI. Returns the text the model reads; remembers the view for the host. */
  async callFromModel(qualified: string, args: Record<string, unknown>, providerToolCallId?: string): Promise<{ text: string; isError: boolean }> {
    const tool = this.find(qualified);
    if (!tool) throw new Error(`no upstream tool ${qualified}`);
    const client = this.clients.get(tool.server)!;
    const result = await client.callTool({ name: tool.name, arguments: args }) as {
      content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown; _meta?: unknown;
    };
    const uri = resourceUriOf(tool._meta);
    if (uri && providerToolCallId) {
      this.pendingUi.set(providerToolCallId, { server: tool.server, tool_name: tool.name, resource_uri: uri, arguments: args, result });
      // Never held for ever: a CLI that never reports the result frees it.
      setTimeout(() => this.pendingUi.delete(providerToolCallId), 10 * 60_000).unref();
    }
    const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`)).join('\n');
    return { text, isError: result.isError === true };
  }

  /** The view for a call, once: attached to the first tool_result frame that names it. */
  takeUi(toolCallId: string): CallUi | undefined {
    const ui = this.pendingUi.get(toolCallId);
    if (ui) this.pendingUi.delete(toolCallId);
    return ui;
  }

  /**
   * A view's request, relayed by the host. Only the two methods a view needs,
   * and a tools/call only for a tool its server lets an app call.
   */
  async request(server: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`no upstream server ${server}`);
    if (method === 'resources/read') {
      const uri = String(params['uri'] ?? '');
      if (!uri.startsWith('ui://')) throw new Error('only ui:// resources are read for a view');
      return client.readResource({ uri });
    }
    if (method === 'tools/call') {
      const name = String(params['name'] ?? '');
      const tool = this.tools.find((t) => t.server === server && t.name === name);
      if (!tool) throw new Error(`no tool ${name} on ${server}`);
      if (!visibility(tool._meta).includes('app')) throw new Error(`${name} is not callable from a view`);
      return client.callTool({ name, arguments: (params['arguments'] ?? {}) as Record<string, unknown> });
    }
    throw new Error(`unsupported method ${method}`);
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.close().catch(() => undefined);
  }
}
