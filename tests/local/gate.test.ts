import { describe, expect, it } from 'vitest';
import { LOCAL_EXECUTION_OFF, refusalReason, runsLocally } from '../../src/local/gate.js';
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
