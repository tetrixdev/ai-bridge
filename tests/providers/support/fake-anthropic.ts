/**
 * A stand-in for the Anthropic Messages API, for driving a REAL `claude` CLI
 * without spending tokens or needing a login: point it here with
 * ANTHROPIC_BASE_URL and a dummy ANTHROPIC_API_KEY.
 *
 * Every POST to /v1/messages is recorded with the system prompt it carried
 * (the text of all `system` blocks, joined) and answered with a one-line
 * assistant message, streamed or not as asked. Anything else gets an empty
 * 200, so the CLI's side requests cannot fail a turn.
 *
 * One scripted move: a conversation whose user text contains SPAWN_HELPER
 * and that has no assistant message yet, offered an `Agent` (or older
 * `Task`) tool, is answered with a call to it whose prompt is HELPER_TASK. That makes the CLI
 * start a real subagent, whose own requests are recorded like any other.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SPAWN_HELPER = 'SPAWN-A-HELPER-NOW';
export const HELPER_TASK = 'helper-task-xyz: reply ok';

export interface RecordedRequest {
  /** The joined text of every `system` block. */
  system: string;
  /** The joined text of every user message's text blocks. */
  userText: string;
  /** The names of the tools the request offered. */
  tools: string[];
}

export interface FakeAnthropic {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .join('\n');
}

function replyToolUse(res: ServerResponse, stream: boolean, model: string, tool: string): void {
  const id = `msg_fake_${Math.random().toString(36).slice(2)}`;
  const toolId = `toolu_fake_${Math.random().toString(36).slice(2)}`;
  const input = { description: 'Fake helper', prompt: HELPER_TASK, subagent_type: 'general-purpose' };
  const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, type: 'message', role: 'assistant', model,
      content: [{ type: 'tool_use', id: toolId, name: tool, input }],
      stop_reason: 'tool_use', stop_sequence: null, usage,
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: tool, input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function reply(res: ServerResponse, stream: boolean, model: string): void {
  const id = `msg_fake_${Math.random().toString(36).slice(2)}`;
  const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', stop_sequence: null, usage,
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST' || path !== '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        // Recorded as empty; the reply still lets the CLI finish.
      }
      const messages = Array.isArray(body['messages']) ? (body['messages'] as Array<Record<string, unknown>>) : [];
      const offered = Array.isArray(body['tools']) ? (body['tools'] as Array<{ name?: unknown }>).map((t) => String(t.name)) : [];
      requests.push({
        tools: offered,
        system: textOf(body['system']),
        userText: messages.filter((m) => m['role'] === 'user').map((m) => textOf(m['content'])).join('\n'),
      });
      const stream = body['stream'] === true;
      const model = typeof body['model'] === 'string' ? body['model'] : 'claude-fake';
      const agentTool = ['Agent', 'Task'].find((n) => offered.includes(n));
      const asked = messages.some((m) => m['role'] === 'user' && textOf(m['content']).includes(SPAWN_HELPER));
      const answered = messages.some((m) => m['role'] === 'assistant');
      if (asked && !answered && agentTool !== undefined) {
        replyToolUse(res, stream, model, agentTool);
        return;
      }
      reply(res, stream, model);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
