/**
 * Tool Prompt Manifest
 *
 * The bridge exposes each server-registered tool as a Bash wrapper script on
 * the AI CLI's PATH (filename = tool name). None of the supported CLIs
 * (claude / codex / gemini) have a protocol-level concept of these external
 * tools, so the model is never told they exist. This module builds a
 * human-readable markdown manifest describing the tools, their parameters,
 * and how to call them, which provider adapters append to the prompt the
 * model receives.
 */

import type { ToolDefinition } from '../protocol/types.js';

/** Shape of a single JSON Schema property entry we care about. */
interface SchemaProperty {
  type?: unknown;
  description?: unknown;
}

/**
 * Build a markdown manifest describing the server-defined bridge tools.
 *
 * Each tool is documented as a shell command on PATH that takes a single
 * JSON-object argument and prints its result to stdout. When `tools` is empty
 * an empty string is returned so callers can append unconditionally.
 *
 * The function is intentionally defensive: a tool's `parameters` may be `{}`,
 * may be missing `properties`, and individual property entries may not be
 * objects. Anything malformed is described as best-effort rather than throwing.
 *
 * @param tools  The server-defined tool definitions for this request.
 * @returns A markdown manifest, or an empty string when there are no tools.
 */
export function buildToolInstructions(
  tools: ToolDefinition[],
  toolScriptDir?: string | null,
): string {
  if (tools.length === 0) return '';

  // Use the absolute path to each tool script in examples. Relying on PATH is
  // fragile — some CLIs run commands through a login shell (`bash -lc`) that
  // re-sources profile scripts and resets PATH, dropping the bridge's tool
  // directory. An absolute path always resolves.
  const cmd = (name: string): string =>
    toolScriptDir ? `${toolScriptDir}/${name}` : name;

  const sections: string[] = [
    '# Available Tools',
    '',
    'You have access to the following tools. Each tool is an executable ' +
      'script. Call a tool by running it as a shell command with a single ' +
      'argument: a JSON object containing the parameters. The command prints ' +
      'its result to stdout. Run each tool using the exact path shown in its ' +
      '"Call it like" example. Use these tools whenever they help fulfill the ' +
      'request.',
  ];

  for (const tool of tools) {
    sections.push('', `## ${tool.name}`, '', tool.description);

    const parameters = (tool.parameters ?? {}) as Record<string, unknown>;
    const properties = (parameters['properties'] ?? {}) as Record<string, unknown>;
    const required = Array.isArray(parameters['required'])
      ? (parameters['required'] as unknown[]).map((r) => String(r))
      : [];
    const propNames = Object.keys(properties);

    if (propNames.length === 0) {
      sections.push('', 'Parameters: No parameters');
      sections.push('', `Call it like: ${cmd(tool.name)} '{}'`);
      continue;
    }

    sections.push('', 'Parameters:');
    for (const pname of propNames) {
      const raw = properties[pname];
      const prop: SchemaProperty =
        raw && typeof raw === 'object' ? (raw as SchemaProperty) : {};
      const type = typeof prop.type === 'string' ? prop.type : 'any';
      const requiredLabel = required.includes(pname) ? 'required' : 'optional';
      const description =
        typeof prop.description === 'string' && prop.description.length > 0
          ? prop.description
          : 'No description';
      sections.push(`- ${pname} (${type}, ${requiredLabel}): ${description}`);
    }

    // Example uses the first parameter so the model sees the calling shape.
    const exampleParam = propNames[0];
    sections.push(
      '',
      `Call it like: ${cmd(tool.name)} '{"${exampleParam}":"<value>"}'`,
    );
  }

  return sections.join('\n');
}
