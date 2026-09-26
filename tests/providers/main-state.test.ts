/**
 * `main_state`: whether the MAIN assistant is working or free, on a turn that
 * keeps its input open. It is what lets a chat say, before anything is typed,
 * whether a message will be read straight away or after the current step.
 *
 * Asserted over whole turns captured from Claude Code 2.1.280 in stream-json
 * input mode (see turn-input.test.ts for how they were captured).
 */

import { describe, it, expect, vi } from 'vitest';
import { stepsFromFixture, runInputTurn, of, mainStates } from './support/input-turn.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';
import type { TurnInputPort } from '../../src/providers/turn-input.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

async function replayWithInjections(fixture: string): Promise<AdapterStreamEvent[]> {
  const { steps, opening, injected } = stepsFromFixture(fixture);
  let offered = false;
  const turn = await runInputTurn({
    steps,
    message: opening,
    onEvent: (event: AdapterStreamEvent, port: TurnInputPort) => {
      // At the first event once input is open (the CLI's first init).
      if (offered || !port.isOpen()) return;
      offered = true;
      injected.forEach((content, i) => port.offer(`m${i + 1}`, content));
    },
  });

  return turn.events;
}

/** No state twice in a row, anywhere. */
function expectAlternating(states: string[]): void {
  for (let i = 1; i < states.length; i++) expect(states[i]).not.toBe(states[i - 1]);
}

describe('main_state', () => {
  it('follows a background command: free while it runs, busy for the message and for its end', async () => {
    const events = await replayWithInjections('claude-input-background-bash-turn.ndjson');
    const states = mainStates(events);

    // Replies "Started." -> free while the command runs -> takes the message
    // and answers "Paris" -> free -> answers the command's end -> free.
    expect(states).toEqual(['working', 'idle', 'working', 'idle', 'working', 'idle']);
    expectAlternating(states);
  });

  it('starts working first thing, right after the ack, before any other event', async () => {
    const events = await replayWithInjections('claude-input-background-bash-turn.ndjson');

    expect(events[0]).toEqual({ event: 'main_state', data: { state: 'working' } });
  });

  it('is working, not idle, whenever a message is read — before its answer begins', async () => {
    const events = await replayWithInjections('claude-input-background-bash-turn.ndjson');
    const read = events.map((e) => e.event).indexOf('user_input');

    // The CLI starts a turn for the message (a fresh init) before echoing it,
    // so the main assistant already reads as working when user_input arrives:
    // the close decision can never slip in between reading and answering.
    const before = events.slice(0, read).filter((e) => e.event === 'main_state');
    expect(before[before.length - 1].data).toEqual({ state: 'working' });
    const answerIdx = events.findIndex((e, i) => i > read && e.event === 'block_start');
    const idleAfter = events.findIndex((e, i) => i > read && e.event === 'main_state');
    expect(answerIdx).toBeGreaterThan(read);
    expect(idleAfter).toBeGreaterThan(answerIdx);
  });

  it('stays working through a foreground step, and is idle only when the reply ends', async () => {
    const events = await replayWithInjections('claude-input-redirect-foreground-bash-turn.ndjson');

    // Blocked on a 40 s command: never free until its answer ends, so a
    // message sent meanwhile is read after the step.
    expect(mainStates(events)).toEqual(['working', 'idle']);
    const idleAt = events.findIndex((e) => e.event === 'main_state' && (e.data as { state: string }).state === 'idle');
    expect(idleAt).toBeGreaterThan(events.map((e) => e.event).indexOf('user_input'));
  });

  it('stays working while it waits on a foreground helper (background tasks off)', async () => {
    // Captured with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, the only way to get
    // a helper the main assistant waits on: the message sent 15 s in was read
    // when the helper returned, 35 s later.
    const events = await replayWithInjections('claude-input-redirect-foreground-helper-turn.ndjson');

    expect(mainStates(events)).toEqual(['working', 'idle']);
    const names = events.map((e) => e.event);
    expect(names.indexOf('user_input')).toBeGreaterThan(names.lastIndexOf('task'));
  });

  it('is idle while a background helper works, and working when the CLI answers its end', async () => {
    const events = await replayWithInjections('claude-input-redirect-background-helper-turn.ndjson');
    const states = mainStates(events);

    expect(states).toEqual(['working', 'idle', 'working', 'idle', 'working', 'idle']);
    // Helpers' own output does not make the MAIN assistant working: between
    // the first idle and the message being read there are helper blocks.
    const firstIdle = events.findIndex((e) => e.event === 'main_state' && (e.data as { state: string }).state === 'idle');
    const secondState = events.findIndex((e, i) => i > firstIdle && e.event === 'main_state');
    const helperBlocks = events.slice(firstIdle, secondState)
      .filter((e) => e.event === 'block_start' && (e.data as { parent_tool_use_id?: string }).parent_tool_use_id);
    expect(helperBlocks.length).toBeGreaterThan(0);
  });

  it('is never sent on a turn that did not ask for input', async () => {
    const { steps } = stepsFromFixture('claude-background-subagent-turn.ndjson');
    const turn = await runInputTurn({ steps: steps.filter((s) => !('waitEof' in s)), message: 'go', withPort: false });

    expect(of(turn.events, 'main_state')).toHaveLength(0);
    expect(of(turn.events, 'user_input')).toHaveLength(0);
    expect(of(turn.events, 'done')).toHaveLength(1);
  });
});
