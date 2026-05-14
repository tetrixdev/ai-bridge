/**
 * Test Mode
 *
 * When the bridge is started with --test, incoming ai_request messages
 * are answered with mock streaming data instead of invoking a real CLI.
 *
 * This is useful for testing the WebSocket connection and the streaming
 * protocol without needing a real AI CLI installed.
 *
 * Mock response flow:
 *   block_start  (thinking, index 0)
 *   block_delta  (thinking content)
 *   block_stop   (index 0)
 *   block_start  (text, index 1)
 *   block_delta  (text content, multiple chunks)
 *   block_stop   (index 1)
 *   done         (with mock usage)
 */

import type { AiRequestMessage, StreamEventType, StreamEventData } from './protocol/types.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('TestMode');

/** Small delay helper for simulating streaming. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle an AI request with mock streaming data.
 *
 * @param request    The incoming AI request from the server.
 * @param sendEvent  Function to send a stream event back to the server.
 */
export async function handleTestRequest(
  request: AiRequestMessage,
  sendEvent: (event: StreamEventType, data: StreamEventData) => void,
): Promise<void> {
  log.info('Test mode: handling mock request', {
    requestId: request.request_id,
    provider: request.provider,
    message: request.message.slice(0, 80),
  });

  // Simulate a short delay before starting
  await delay(100);

  // --- Thinking block (index 0) ---
  sendEvent('block_start', {
    block_index: 0,
    block_type: 'thinking',
  });
  await delay(50);

  const thinkingChunks = [
    'Let me think about this request... ',
    `The user asked: "${request.message.slice(0, 50)}". `,
    'I will provide a helpful mock response.',
  ];

  for (const chunk of thinkingChunks) {
    sendEvent('block_delta', {
      block_index: 0,
      content: chunk,
    });
    await delay(30);
  }

  sendEvent('block_stop', {
    block_index: 0,
  });
  await delay(50);

  // --- Text block (index 1) ---
  sendEvent('block_start', {
    block_index: 1,
    block_type: 'text',
  });
  await delay(50);

  const textChunks = [
    'This is a **mock response** from ai-bridge test mode. ',
    'The bridge is connected and streaming is working correctly. ',
    `Your request was routed to the "${request.provider}" provider. `,
    'In production, this response would come from your local CLI tool. ',
    `\n\nOriginal message: "${request.message.slice(0, 100)}"`,
  ];

  for (const chunk of textChunks) {
    sendEvent('block_delta', {
      block_index: 1,
      content: chunk,
    });
    await delay(40);
  }

  sendEvent('block_stop', {
    block_index: 1,
  });
  await delay(50);

  // --- Done ---
  sendEvent('done', {
    usage: {
      input_tokens: 42,
      output_tokens: 108,
    },
  });

  log.info('Test mode: mock response complete', { requestId: request.request_id });
}
