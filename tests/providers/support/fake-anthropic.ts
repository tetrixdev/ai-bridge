/**
 * A stand-in for the Anthropic Messages API, for driving a REAL `claude` CLI
 * without spending tokens or needing a login: point it here with
 * ANTHROPIC_BASE_URL and a dummy ANTHROPIC_API_KEY.
 *
 * Every POST to /v1/messages is recorded with the system prompt it carried
 * (the text of all `system` blocks, joined) and answered with a one-line
 * assistant message, streamed or not as asked. Anything else gets an empty
 * 200, so the CLI's side requests cannot fail a turn.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  /** The joined text of every `system` block. */
  system: string;
  /** The joined text of every user message's text blocks. */
  userText: string;
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
      requests.push({
        system: textOf(body['system']),
        userText: messages.filter((m) => m['role'] === 'user').map((m) => textOf(m['content'])).join('\n'),
      });
      reply(res, body['stream'] === true, typeof body['model'] === 'string' ? body['model'] : 'claude-fake');
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
