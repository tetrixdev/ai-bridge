/**
 * The return direction: a file the assistant produced, handed back to the chat.
 *
 * There is no new WebSocket frame for this, and there does not need to be. The
 * bridge already runs a local MCP server exposing the server's tools to the
 * CLI, so the return path is one more tool alongside them — a bridge-owned one
 * this time. The model calls it with a path; the bridge uploads that file and
 * emits an `attachment` stream event the UI can render.
 *
 * The model has to nominate the file, and that is not a limitation to work
 * around. A transport cannot guess which of the hundred files a turn just
 * touched is the answer, and anything that tried would either miss the one
 * that mattered or send the lot.
 */

import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve as resolvePath, sep } from 'node:path';

/** The tool the model calls. Namespaced so it cannot collide with a server tool. */
export const ATTACH_FILE_TOOL = 'bridge__attach_file';

/** What the server says about a file it accepted. */
export interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
}

/** Everything the upload needs to know about the turn it belongs to. */
export interface UploadContext {
  /** Where the CLI is working. A file here may be sent. */
  workingDir: string;
  /** This turn's attachment directory, when it has one. Also sendable. */
  attachmentDir: string | null;
  /** Origin to upload to — the same one attachments are fetched from. */
  apiOrigin: string;
  /** The bridge's connection token. */
  token: string;
  /** Per-file cap, shared with the inbound path. */
  maxFileBytes: number;
}

/** The MCP tool definition advertised to the CLI. */
export const ATTACH_FILE_TOOL_DEFINITION = {
  name: ATTACH_FILE_TOOL,
  description:
    'Send a file from this machine back to the user in the chat. Use it when the user '
    + 'asked for a file as the answer — a generated report, an export, a diff. '
    + 'The path must be inside the working directory or the directory the turn\'s '
    + 'attachments were saved in.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the file to send.',
      },
      description: {
        type: 'string',
        description: 'One short line about what the file is, shown next to it in the chat.',
      },
    },
    required: ['path'],
  },
} as const;

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Check a model-supplied path is one this turn is allowed to send.
 *
 * Same shape as the working-directory check, and for the same reason: the
 * comparison happens after `realpath`, so a symlink the model just created
 * pointing at `~/.ssh/id_ed25519` is caught rather than followed. The model
 * has a shell in `workspace` mode, so it can absolutely create one.
 */
export function resolveUploadPath(rawPath: string, ctx: UploadContext): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('path is required');
  }
  if (rawPath.includes('\0')) {
    throw new Error('path contains a null byte');
  }
  if (!isAbsolute(rawPath)) {
    throw new Error(`path must be absolute (got "${rawPath}")`);
  }

  const roots = [ctx.workingDir, ctx.attachmentDir].filter((r): r is string => !!r);

  let resolved: string;
  try {
    resolved = realpathSync(resolvePath(rawPath));
  } catch {
    throw new Error(`no such file: ${rawPath}`);
  }

  const resolvedRoots = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });

  if (!resolvedRoots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      `"${rawPath}" is outside the directories this turn may send from `
      + `(${resolvedRoots.join(', ')}).`,
    );
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`"${rawPath}" is not a regular file`);
  }
  if (stat.size > ctx.maxFileBytes) {
    throw new Error(
      `"${basename(resolved)}" is ${stat.size} bytes, over the ${ctx.maxFileBytes}-byte limit`,
    );
  }

  return resolved;
}

/**
 * Upload one file to the server and return what it says about it.
 *
 * Goes to the same origin the inbound path fetches from, with the same bearer
 * credential — so the host binding that stops a hostile server aiming the
 * bridge at a third party covers this direction too.
 */
export async function uploadAttachment(
  rawPath: string,
  description: string | undefined,
  ctx: UploadContext,
  signal?: AbortSignal,
): Promise<UploadedAttachment> {
  const path = resolveUploadPath(rawPath, ctx);
  const name = basename(path);
  const bytes = await readFile(path);

  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  if (description) {
    form.append('description', description);
  }

  const response = await fetch(`${ctx.apiOrigin}/ai-bridge/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}` },
    body: form,
    redirect: 'error',
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`server rejected the upload with HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    id?: string;
    url?: string;
    name?: string;
    mime_type?: string;
    size?: number;
  };

  if (!body.id) {
    throw new Error('server accepted the upload but returned no attachment id');
  }

  return {
    id: body.id,
    name: body.name ?? name,
    mimeType: body.mime_type ?? 'application/octet-stream',
    size: body.size ?? bytes.byteLength,
    ...(body.url ? { url: body.url } : {}),
  };
}
