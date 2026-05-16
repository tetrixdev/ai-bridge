import { describe, it, expect } from 'vitest';
import { buildToolInstructions } from '../../src/tools/prompt.js';
import type { ToolDefinition } from '../../src/protocol/types.js';

describe('buildToolInstructions()', () => {
  it('returns an empty string when there are no tools', () => {
    expect(buildToolInstructions([])).toBe('');
  });

  it('includes the Available Tools header explaining the calling convention', () => {
    const tools: ToolDefinition[] = [
      { name: 'roll_dice', description: 'Rolls a die', parameters: {} },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('# Available Tools');
    expect(out).toContain('JSON object');
    expect(out).toContain('stdout');
  });

  it('uses the absolute tool path in examples when a script dir is given', () => {
    const tools: ToolDefinition[] = [
      { name: 'roll_dice', description: 'Rolls a die', parameters: {} },
    ];
    const out = buildToolInstructions(tools, '/tmp/ai-bridge-tools-abc');

    expect(out).toContain(`Call it like: /tmp/ai-bridge-tools-abc/roll_dice '{}'`);
  });

  it('falls back to the bare tool name when no script dir is given', () => {
    const tools: ToolDefinition[] = [
      { name: 'roll_dice', description: 'Rolls a die', parameters: {} },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain(`Call it like: roll_dice '{}'`);
  });

  it('includes each tool name and description', () => {
    const tools: ToolDefinition[] = [
      { name: 'web_search', description: 'Searches the web', parameters: {} },
      { name: 'roll_dice', description: 'Rolls dice', parameters: {} },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('## web_search');
    expect(out).toContain('Searches the web');
    expect(out).toContain('## roll_dice');
    expect(out).toContain('Rolls dice');
  });

  it('documents each parameter with type, required/optional, and description', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Searches the web',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
            limit: { type: 'number', description: 'Max results' },
          },
          required: ['query'],
        },
      },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('- query (string, required): The search query');
    expect(out).toContain('- limit (number, optional): Max results');
  });

  it('includes a calling-convention example for tools with parameters', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Searches the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The query' } },
          required: ['query'],
        },
      },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain(`Call it like: web_search '{"query":"<value>"}'`);
  });

  it('handles tools with no parameters', () => {
    const tools: ToolDefinition[] = [
      { name: 'ping', description: 'Pings the server', parameters: {} },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('## ping');
    expect(out).toContain('No parameters');
    expect(out).toContain(`Call it like: ping '{}'`);
  });

  it('treats parameters with empty properties as no parameters', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'ping',
        description: 'Pings the server',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('No parameters');
    expect(out).toContain(`Call it like: ping '{}'`);
  });

  it('is defensive when parameters is missing properties', () => {
    const tools: ToolDefinition[] = [
      { name: 'ping', description: 'Pings', parameters: { type: 'object' } },
    ];
    expect(() => buildToolInstructions(tools)).not.toThrow();
    expect(buildToolInstructions(tools)).toContain('No parameters');
  });

  it('falls back to "any" type and "No description" for malformed properties', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'thing',
        description: 'Does a thing',
        parameters: {
          type: 'object',
          properties: { foo: {} },
        },
      },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('- foo (any, optional): No description');
  });

  it('renders all tools in a multi-tool manifest', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Searches the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The query' } },
          required: ['query'],
        },
      },
      { name: 'ping', description: 'Pings the server', parameters: {} },
    ];
    const out = buildToolInstructions(tools);

    expect(out).toContain('## web_search');
    expect(out).toContain('## ping');
    expect(out.indexOf('## web_search')).toBeLessThan(out.indexOf('## ping'));
  });
});
