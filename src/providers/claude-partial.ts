/**
 * Claude partial-message stream mapping.
 *
 * With `--include-partial-messages`, the Claude CLI emits a `stream_event`
 * frame per raw Anthropic SSE event, so text arrives in chunks as the model
 * writes it instead of one lump per content block. This maps those frames onto
 * the bridge's existing block model — one `block_start`, many `block_delta`, one
 * `block_stop` — which is what PROTOCOL.md already describes and what every
 * consumer already handles. No protocol change; the deltas just get smaller.
 *
 * Shapes below were captured from Claude Code 2.1.261 rather than assumed, and
 * three of them are traps:
 *
 *  1. The whole-message `assistant` frame STILL ARRIVES for a message that was
 *     streamed — in the middle of it, between the last delta and
 *     `content_block_stop`. Handling both paths naively emits every block
 *     twice. See `wasStreamed()`.
 *
 *  2. `content_block_start.index` RESTARTS AT 0 for each message in the turn.
 *     A turn that calls a tool has at least two messages, so the raw index is
 *     not usable as a bridge block index — two different blocks would collide
 *     on index 0 and a consumer keyed on it would splice them together. The
 *     mapper translates each CLI index to a monotonic bridge index.
 *
 *  3. Thinking blocks carry `signature_delta` alongside `thinking_delta`. The
 *     signature is an opaque crypto attestation, not prose, and forwarding it
 *     as content injects a wall of base64 into the user's view of the model's
 *     reasoning.
 */

import type { AdapterStreamEvent } from './base.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ClaudePartial');

/** Bridge block types that a partial stream can produce. */
type MappedBlockType = 'text' | 'thinking' | 'tool_call';

/** Read a string field, or undefined when it is absent or the wrong type. */
function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a nested object field, or undefined. */
function obj(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Translates Claude's `stream_event` frames into bridge block events.
 *
 * Also owns the turn's block-index counter, because the whole-message path runs
 * alongside it in the same turn: sub-agent messages (the Task tool) are
 * delivered ONLY as whole `assistant` frames — the CLI emits no `stream_event`
 * for a sidechain — so both paths allocate from one counter to keep indices
 * unique across the turn.
 */
export class ClaudePartialStreamMapper {
  private nextBlockIndex = 0;

  /** CLI content-block index → bridge block index, for the message in flight. */
  private readonly bridgeIndex = new Map<number, number>();

  /** CLI content-block index → what kind of block it is. */
  private readonly blockType = new Map<number, MappedBlockType>();

  /**
   * Text and thinking blocks that have been announced but not yet opened.
   *
   * Their `block_start` is withheld until the first delta with actual content
   * arrives, because the whole-message path skips a block whose text is empty
   * (`if (!text) continue`) and the two paths have to agree. Interleaved
   * thinking really does come through empty — the tool-turn fixture contains a
   * thinking block that is nothing but a signature — so opening eagerly would
   * put a hollow reasoning block in front of the user on a real turn, and shift
   * every index after it.
   */
  private readonly pending = new Map<number, MappedBlockType>();

  /** Accumulated `input_json_delta` fragments, keyed by CLI index. */
  private readonly toolJson = new Map<number, string>();

  /** Message ids delivered as a partial stream, so the `assistant` twin is dropped. */
  private readonly streamedMessageIds = new Set<string>();

  /** Allocate the next bridge block index (used by the whole-message path too). */
  nextIndex(): number {
    return this.nextBlockIndex++;
  }

  /**
   * Was this message already delivered as a partial stream?
   *
   * Keyed on the Anthropic message id, which `message_start` and the
   * `assistant` frame carry identically — verified against 2.1.261. A coarser
   * rule ("partial mode is on, so drop every assistant frame") would silently
   * discard sub-agent output, which has an id that never appears in any
   * `message_start` precisely because sidechains are not streamed.
   */
  wasStreamed(messageId: string | undefined): boolean {
    return messageId !== undefined && this.streamedMessageIds.has(messageId);
  }

  /** Handle one `stream_event` frame, emitting whatever bridge events it maps to. */
  handle(frame: Record<string, unknown>, emit: (event: AdapterStreamEvent) => void): void {
    const event = obj(frame, 'event');
    if (!event) return;

    switch (str(event, 'type')) {
      case 'message_start':
        return this.onMessageStart(event);
      case 'content_block_start':
        return this.onBlockStart(event, emit);
      case 'content_block_delta':
        return this.onBlockDelta(event, emit);
      case 'content_block_stop':
        return this.onBlockStop(event, emit);
      default:
        // message_delta / message_stop / ping carry nothing the block model
        // needs; `result` still drives the turn's terminal event.
        return;
    }
  }

  private onMessageStart(event: Record<string, unknown>): void {
    const id = str(obj(event, 'message'), 'id');
    if (id !== undefined) this.streamedMessageIds.add(id);

    // Per-message state only. The CLI reuses indices from 0 for each message,
    // so anything keyed on a CLI index must not outlive the message.
    this.bridgeIndex.clear();
    this.blockType.clear();
    this.toolJson.clear();
    this.pending.clear();
  }

  private onBlockStart(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const cliIndex = event['index'];
    if (typeof cliIndex !== 'number') return;

    const block = obj(event, 'content_block');
    const rawType = str(block, 'type');

    let type: MappedBlockType;
    if (rawType === 'text') {
      type = 'text';
    } else if (rawType === 'thinking') {
      type = 'thinking';
    } else if (rawType === 'tool_use') {
      type = 'tool_call';
    } else {
      // redacted_thinking and any future block type: no index is allocated, so
      // its deltas and its stop find no mapping and are dropped too. Matches
      // what the whole-message path does with a type it does not know.
      log.debug('Ignoring unmapped content block type', { blockType: rawType });
      return;
    }

    if (type === 'tool_call') {
      const toolName = str(block, 'name');
      const toolId = str(block, 'id');
      if (toolName === undefined || toolId === undefined) {
        // Same guard as the whole-message path: a tool block with no identity
        // is not something a consumer can pair a result to.
        return;
      }
      // Opened eagerly: a tool block always produces its arguments delta at
      // stop, so there is no empty case to wait for.
      const index = this.nextIndex();
      this.bridgeIndex.set(cliIndex, index);
      this.blockType.set(cliIndex, type);
      this.toolJson.set(cliIndex, '');
      emit({
        event: 'block_start',
        data: { block_index: index, block_type: 'tool_call', tool_name: toolName, tool_call_id: toolId },
      });
      return;
    }

    this.pending.set(cliIndex, type);
  }

  /**
   * Open a withheld text/thinking block, allocating its index now.
   *
   * Allocating here rather than at `content_block_start` is what keeps indices
   * matching the whole-message path: a block that turns out to be empty
   * consumes no index, so the block after it is numbered the same either way.
   */
  private open(cliIndex: number, emit: (e: AdapterStreamEvent) => void): number | undefined {
    const type = this.pending.get(cliIndex);
    if (type === undefined) return this.bridgeIndex.get(cliIndex);

    this.pending.delete(cliIndex);
    const index = this.nextIndex();
    this.bridgeIndex.set(cliIndex, index);
    this.blockType.set(cliIndex, type);
    emit({ event: 'block_start', data: { block_index: index, block_type: type } });
    return index;
  }

  private onBlockDelta(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const cliIndex = event['index'];
    if (typeof cliIndex !== 'number') return;

    const delta = obj(event, 'delta');
    const deltaType = str(delta, 'type');

    if (deltaType === 'input_json_delta') {
      if (!this.toolJson.has(cliIndex)) return;
      // BUFFERED, not forwarded. Tool arguments are the one place the handover
      // flagged that a downstream consumer could break, and streaming them
      // buys nothing a person can see — arguments are rendered as a unit, not
      // read as they are typed. Emitting one delta at block_stop keeps the
      // tool_call wire shape byte-identical to the whole-message path.
      const fragment = str(delta, 'partial_json');
      if (fragment !== undefined) this.toolJson.set(cliIndex, (this.toolJson.get(cliIndex) ?? '') + fragment);
      return;
    }

    // `signature_delta` deliberately falls through to nothing: it is the
    // thinking block's crypto attestation, not part of the reasoning text.
    const content = deltaType === 'text_delta'
      ? str(delta, 'text')
      : deltaType === 'thinking_delta'
        ? str(delta, 'thinking')
        : undefined;

    if (content === undefined || content === '') return;

    // Only now is the block known to be non-empty, so this is where it opens.
    const index = this.open(cliIndex, emit);
    if (index === undefined) return;

    emit({ event: 'block_delta', data: { block_index: index, content } });
  }

  private onBlockStop(event: Record<string, unknown>, emit: (e: AdapterStreamEvent) => void): void {
    const cliIndex = event['index'];
    if (typeof cliIndex !== 'number') return;

    // A block that was announced and never produced content is dropped whole,
    // exactly as the whole-message path drops one whose text is empty.
    this.pending.delete(cliIndex);

    const index = this.bridgeIndex.get(cliIndex);
    if (index === undefined) return;

    if (this.blockType.get(cliIndex) === 'tool_call') {
      emit({
        event: 'block_delta',
        data: { block_index: index, content: normaliseToolArguments(this.toolJson.get(cliIndex)) },
      });
    }

    emit({ event: 'block_stop', data: { block_index: index } });

    this.bridgeIndex.delete(cliIndex);
    this.blockType.delete(cliIndex);
    this.toolJson.delete(cliIndex);
  }
}

/**
 * Turn accumulated `input_json_delta` fragments into the exact string the
 * whole-message path would have sent — `JSON.stringify(input ?? {})`.
 *
 * Re-encoding rather than forwarding the concatenation is what makes the two
 * paths interchangeable. A tool called with no arguments streams either zero
 * fragments or a single empty one, so the raw buffer is `""` — not valid JSON,
 * and `JSON.parse` on the far side throws on a turn that looked fine here.
 * Whitespace from the model's own encoding is normalised away for the same
 * reason: so a recorded turn does not differ by which path produced it.
 */
export function normaliseToolArguments(buffered: string | undefined): string {
  const raw = (buffered ?? '').trim();
  if (raw === '') return '{}';

  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    // Truncated or malformed JSON — the CLI died mid-block, or the shape
    // changed. Forward it verbatim rather than inventing `{}`: a consumer that
    // fails to parse this can say so, where a silently empty argument object
    // would look like a tool deliberately called with no arguments.
    log.warn('Tool arguments did not parse as JSON — forwarding verbatim', { length: raw.length });
    return raw;
  }
}
