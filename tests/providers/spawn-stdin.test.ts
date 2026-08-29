import { describe, it, expect } from 'vitest';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { ProviderAdapter } from '../../src/providers/base.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';

/**
 * Regression test for the stdin EPIPE crash: when Claude (or any CLI) is fed its
 * prompt via stdin but exits before reading it, the async write would emit an
 * unhandled 'error' on the stdin stream → uncaughtException → the whole bridge
 * dies. spawnCli must attach an error handler so a fast-exiting child can never
 * crash the process. We drive a real, immediately-exiting child with a large
 * payload (the size that reliably triggers EPIPE) and assert the bridge survives.
 */
class TestAdapter extends ProviderAdapter {
  readonly providerName = 'test';
  execute(_c: ExecutionContext, _e: (event: AdapterStreamEvent) => void): Promise<string | null> {
    return Promise.resolve(null);
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
  // Expose the protected spawn for testing.
  public spawn(command: string, args: string[], stdinInput?: string): ChildProcessByStdio<Writable | null, Readable, Readable> {
    return this.spawnCli(command, args, process.env, stdinInput);
  }
}

describe('spawnCli stdin handling', () => {
  it('does not crash the process when the child exits before reading a large stdin payload', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const adapter = new TestAdapter();
      // A child that exits instantly without ever reading stdin; a multi-MB
      // payload guarantees the write outlives the child → EPIPE if unguarded.
      const bigPayload = 'x'.repeat(4 * 1024 * 1024);
      const child = adapter.spawn(process.execPath, ['-e', 'process.exit(0)'], bigPayload);

      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      // Give any deferred error event a tick to surface as uncaughtException.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
