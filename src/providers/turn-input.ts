/**
 * Messages for a turn that is still running.
 *
 * A turn started with `options.accepts_input` keeps the CLI's stdin open, so a
 * message the person types mid-turn can be written to the same process rather
 * than waiting for the next one. This is the seam between the two owners of
 * that: the bridge, which receives `turn_input` from the server and must answer
 * it at once, and the adapter, which owns the CLI's stdin and is the only one
 * that sees the CLI read the message.
 *
 * One port per turn. The bridge creates it before the turn runs; the adapter
 * opens it once the CLI has started its session (its first `system/init`) and
 * ends it the moment it closes stdin. So the answer to "can this message still
 * reach the assistant?" is always the adapter's, and is given on the same
 * event loop as its decision to close — an accepted message can never be lost
 * to a close in between.
 */

import type { TurnInputRejection } from '../protocol/types.js';

/** The bridge's answer to one `turn_input`. */
export type TurnInputOutcome =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: TurnInputRejection };

/**
 * The NDJSON frame that hands the CLI one user message on stdin.
 *
 * Verified against Claude Code 2.1.280 with
 * `-p --input-format stream-json --replay-user-messages`: this minimal shape is
 * accepted, and the CLI echoes it back as
 * `{"type":"user","message":{"role":"user","content":"…"},"session_id":…,
 * "parent_tool_use_id":null,"uuid":…,"timestamp":…,"isReplay":true}` at the
 * moment it takes the message in.
 */
export function userMessageFrame(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

export class TurnInputPort {
  private writer: ((frame: string) => void) | null = null;
  private onAccept: (() => void) | null = null;
  private ended = false;
  /** Accepted and not yet read by the assistant, oldest first. */
  private readonly fifo: Array<{ messageId: string; content: string }> = [];
  /**
   * Every message_id this turn accepted. A server that did not hear an ack in
   * time sends the same message again; writing it twice would have the
   * assistant read it twice.
   */
  private readonly accepted = new Set<string>();

  /**
   * The adapter's CLI is running with stdin open: start taking messages.
   *
   * @param write    writes one frame to the CLI's stdin
   * @param onAccept called after a message was written, so the adapter can
   *                 count it as activity and re-evaluate its close decision
   */
  open(write: (frame: string) => void, onAccept: () => void): void {
    if (this.ended) return;
    this.writer = write;
    this.onAccept = onAccept;
  }

  /**
   * stdin is closed or the turn is being stopped: nothing more can be
   * delivered. Further offers are answered `turn_ending`; once the bridge has
   * forgotten the turn it answers `turn_not_running` itself.
   */
  end(): void {
    this.ended = true;
    this.writer = null;
    this.onAccept = null;
  }

  isOpen(): boolean {
    return !this.ended && this.writer !== null;
  }

  isEnded(): boolean {
    return this.ended;
  }

  /**
   * Deliver a message to the running CLI, or say why not.
   *
   * Idempotent per message_id: a message already accepted is answered
   * `accepted` again and NOT written again — whatever has happened since,
   * since it was delivered either way (read, or pending and reported with the
   * turn's end). Only acceptance is remembered: a rejected message was never
   * written, so a retry of it is judged afresh.
   */
  offer(messageId: string, content: string): TurnInputOutcome {
    if (this.accepted.has(messageId)) return { status: 'accepted' };
    // Ended while the bridge still counts the turn as running: stdin is closed
    // or the turn is being stopped, and the CLI may still be alive. Not
    // `turn_not_running`, which tells the server it may start a new turn —
    // that would resume the session while this CLI still writes to it.
    if (this.ended) return { status: 'rejected', reason: 'turn_ending' };
    if (this.writer === null) return { status: 'rejected', reason: 'input_not_open' };

    this.writer(userMessageFrame(content));
    this.accepted.add(messageId);
    this.fifo.push({ messageId, content });
    this.onAccept?.();

    return { status: 'accepted' };
  }

  /** The CLI echoed the oldest pending message: it has been read. */
  shiftRead(): string | undefined {
    return this.fifo.shift()?.messageId;
  }

  /** What the oldest pending message said, to match the CLI's echo against. */
  peekContent(): string | undefined {
    return this.fifo[0]?.content;
  }

  /** Accepted messages the assistant has not read yet, oldest first. */
  pending(): string[] {
    return this.fifo.map((entry) => entry.messageId);
  }

  pendingCount(): number {
    return this.fifo.length;
  }
}
