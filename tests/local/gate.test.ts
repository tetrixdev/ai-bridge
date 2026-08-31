import { describe, expect, it } from 'vitest';
import { LOCAL_EXECUTION_OFF, localCallRefusal, refusalReason, runsLocally } from '../../src/local/gate.js';
import type { ToolDefinition } from '../../src/protocol/types.js';

const serverTool: ToolDefinition = { name: 'roll_dice', description: '', parameters: {} };
const localTool: ToolDefinition = {
  name: 'deploy', description: '', parameters: {}, execute: 'local',
  run: { command: 'echo' },
};

describe('the local execution gate', () => {
  it('refuses a local tool on a bridge that never opted in', () => {
    // This is the DungeonMeister posture: it never configures local execution,
    // so even a server that has been compromised into sending execute:'local'
    // gets nothing run on the operator's machine.
    expect(runsLocally(LOCAL_EXECUTION_OFF, localTool)).toBe(false);
    expect(refusalReason(LOCAL_EXECUTION_OFF, localTool)).toMatch(/not started with local execution/);
  });

  it('leaves ordinary server tools alone in both postures', () => {
    expect(runsLocally(LOCAL_EXECUTION_OFF, serverTool)).toBe(false);
    expect(runsLocally({ enabled: true }, serverTool)).toBe(false);
    // Not a refusal: a server tool was never asking to run here.
    expect(refusalReason({ enabled: true }, serverTool)).toBeNull();
  });

  it('treats an absent execute field as server, so old servers are unchanged', () => {
    const { execute, ...withoutField } = localTool;
    expect(execute).toBe('local');
    expect(runsLocally({ enabled: true }, withoutField as ToolDefinition)).toBe(false);
  });

  it('runs a local tool only when the operator turned it on', () => {
    expect(runsLocally({ enabled: true }, localTool)).toBe(true);
    expect(refusalReason({ enabled: true }, localTool)).toBeNull();
  });

  it('says nothing about an unknown tool', () => {
    expect(runsLocally({ enabled: true }, undefined)).toBe(false);
    expect(refusalReason({ enabled: true }, undefined)).toBeNull();
  });
});

describe('the same gate, on the local_call path', () => {
  it('refuses a local_call outright when local execution was never enabled', () => {
    // A local_call is a second way into the same capability. A second way in
    // that consults a second flag is how a gate stops being a gate, so this
    // asserts the same posture from the other door.
    expect(localCallRefusal(LOCAL_EXECUTION_OFF)).toMatch(/not started with local execution enabled/);
    expect(localCallRefusal({ enabled: false })).toBeTruthy();
  });

  it('lets one through only when the operator turned it on', () => {
    expect(localCallRefusal({ enabled: true })).toBeNull();
  });

  it('needs exactly true here too, not merely truthy', () => {
    expect(localCallRefusal({ enabled: 1 as unknown as boolean })).toBeTruthy();
    expect(localCallRefusal({ enabled: 'yes' as unknown as boolean })).toBeTruthy();
  });
});

describe('the off posture cannot be edited from inside the process', () => {
  it('is frozen, so nothing can flip it for every default bridge at once', () => {
    expect(Object.isFrozen(LOCAL_EXECUTION_OFF)).toBe(true);
    // Silent in sloppy mode, throws under the module's strictness; either way
    // the value must not change.
    try { (LOCAL_EXECUTION_OFF as { enabled: boolean }).enabled = true; } catch { /* expected */ }
    expect(LOCAL_EXECUTION_OFF.enabled).toBe(false);
    expect(runsLocally(LOCAL_EXECUTION_OFF, localTool)).toBe(false);
  });

  it('needs exactly true, not merely truthy', () => {
    expect(runsLocally({ enabled: 1 as unknown as boolean }, localTool)).toBe(false);
    expect(runsLocally({ enabled: 'yes' as unknown as boolean }, localTool)).toBe(false);
  });
});
