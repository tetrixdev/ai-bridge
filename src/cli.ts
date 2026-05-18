/**
 * CLI Entry Point for @tetrixdev/ai-bridge
 *
 * Parses command-line arguments, detects local AI CLI providers,
 * creates a Bridge instance, and connects to the server.
 *
 * Usage:
 *   npx @tetrixdev/ai-bridge --server wss://example.com/api/ai-bridge/ws --token <token>
 *   AI_BRIDGE_TOKEN=xxx AI_BRIDGE_SERVER=wss://... npx @tetrixdev/ai-bridge
 *   npx @tetrixdev/ai-bridge --server wss://... --token <token> --test
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { Bridge, FatalBridgeError } from './bridge.js';
import { detectProviders } from './providers/detector.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeAdapter } from './providers/claude.js';
import { GeminiAdapter } from './providers/gemini.js';
import type { ProviderAdapter } from './providers/base.js';
import { handleTestRequest } from './test-mode.js';
import { setDebug, setLogFile, closeLogFile, createLogger } from './utils/logger.js';
import { BRIDGE_VERSION, PROTOCOL_VERSION } from './protocol/version.js';

const log = createLogger('CLI');

// ---------------------------------------------------------------------------
// CLI Definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('ai-bridge')
  .description('Local CLI bridge for AI web apps — connects Codex, Claude, and Gemini to your web application via WebSocket')
  .version(BRIDGE_VERSION)
  .option(
    '-t, --token <token>',
    'Authentication token (or set AI_BRIDGE_TOKEN env var)',
    process.env['AI_BRIDGE_TOKEN'],
  )
  .option(
    '-s, --server <url>',
    'WebSocket server URL (or set AI_BRIDGE_SERVER env var)',
    process.env['AI_BRIDGE_SERVER'],
  )
  .option(
    '-d, --debug',
    'Enable verbose debug logging',
    false,
  )
  .option(
    '--test',
    'Test mode — respond to AI requests with mock streaming data (--server and --token still required for the WebSocket connection)',
    false,
  )
  .option(
    '--log-file <path>',
    'Also append logs to this file (or set AI_BRIDGE_LOG_FILE env var). Rotates once past 5 MB, keeping one previous copy.',
    process.env['AI_BRIDGE_LOG_FILE'],
  )
  .action(async (opts: { token?: string; server?: string; debug: boolean; test: boolean; logFile?: string }) => {
    // Enable debug logging if requested
    if (opts.debug) {
      setDebug(true);
    }

    // Start file logging before anything else is logged, so the run is
    // captured from the first line.
    if (opts.logFile) {
      setLogFile(opts.logFile);
    }

    log.info(`AI Bridge v${BRIDGE_VERSION} (protocol v${PROTOCOL_VERSION})`);
    if (opts.logFile) {
      log.info(`Logging to file: ${opts.logFile}`);
    }

    if (opts.test) {
      log.info('Running in TEST MODE — AI requests will receive mock responses');
    }

    // Validate required options
    const token = opts.token;
    const serverUrl = opts.server;

    if (!token) {
      log.error('Authentication token is required. Use --token <token> or set AI_BRIDGE_TOKEN. Generate a token from your web application (see README for details).');
      process.exit(1);
    }

    if (!serverUrl) {
      log.error('Server URL is required. Use --server <url> or set AI_BRIDGE_SERVER. Use the wss:// address provided by your web application (e.g. wss://your-app.com/api/ai-bridge/ws).');
      process.exit(1);
    }

    // Validate server URL format
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      log.error('Server URL must start with ws:// or wss://');
      process.exit(1);
    }

    // Warn about unencrypted connections
    if (serverUrl.startsWith('ws://')) {
      log.warn('Connecting over unencrypted ws://. Use wss:// in production.');
    }

    // Reject URLs with username/password components to prevent URL authority
    // confusion (e.g. wss://legit.com@attacker.com/ws)
    try {
      const parsedUrl = new URL(serverUrl);
      if (parsedUrl.username || parsedUrl.password) {
        log.error('Server URL must not contain username or password components');
        process.exit(1);
      }
    } catch {
      log.error('Server URL is not a valid URL');
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Detect providers
    // -----------------------------------------------------------------------

    const providers = await detectProviders();
    const availableProviders = providers.filter((p) => p.available);

    if (availableProviders.length === 0 && !opts.test) {
      // Warn BEFORE connecting so the user knows the bridge is non-functional.
      log.warn('No AI CLI tools detected. The bridge will NOT be able to execute requests.');
      log.warn('Install one of: codex (https://github.com/openai/codex), claude (https://claude.ai/download), gemini (https://github.com/google-gemini/gemini-cli)');
      log.warn('Or use --test flag to run in test mode with mock responses.');
      log.warn('AI requests will fail until a provider CLI is installed. See install links above.');
      log.warn('Connecting anyway so the server knows a bridge is present...');
    } else if (availableProviders.length > 0) {
      log.info(`Available providers: ${availableProviders.map((p) => `${p.name} (${p.version ?? 'unknown version'})`).join(', ')}`);
    }

    // -----------------------------------------------------------------------
    // Initialize adapters and populate model lists
    // -----------------------------------------------------------------------

    const adapterInstances: ProviderAdapter[] = [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new GeminiAdapter(),
    ];

    const adapters = new Map<string, ProviderAdapter>();
    // Run listModels() concurrently across all available providers.
    const availableAdapters = adapterInstances.filter((adapter) => {
      const capability = providers.find((p) => p.name === adapter.providerName);
      return capability?.available === true;
    });

    await Promise.all(
      availableAdapters.map(async (adapter) => {
        const capability = providers.find((p) => p.name === adapter.providerName)!;
        adapters.set(adapter.providerName, adapter);
        try {
          const models = await adapter.listModels();
          capability.models = models;
          log.info(`${adapter.providerName} models: ${models.map((m) => m.id).join(', ')}`);
        } catch (err) {
          log.warn(`Failed to list models for ${adapter.providerName}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        log.debug('Registered adapter', { name: adapter.providerName });
      }),
    );

    // -----------------------------------------------------------------------
    // Create and connect bridge
    // Token goes in the URL query param (?token=...), NOT in the hello body
    // -----------------------------------------------------------------------

    const bridge = new Bridge({
      serverUrl,
      token,
      providers,
      adapters,
      testMode: opts.test,
      onTestRequest: opts.test ? handleTestRequest : undefined,
    });

    // Lifecycle logging
    bridge.on('connected', () => {
      log.info('Connected to server');
    });

    bridge.on('welcome', (sessionId) => {
      log.info(`Session established: ${sessionId}`);
      if (opts.test) {
        log.info('Test mode active — waiting for ai_request messages...');
      }
    });

    bridge.on('disconnected', (code, reason) => {
      log.warn(`Disconnected from server (code=${code}, reason="${reason}")`);
    });

    bridge.on('error', (err) => {
      log.error('Bridge error', { error: err.message });

      if (err instanceof FatalBridgeError) {
        process.exit(1);
      }
    });

    bridge.on('request_start', (requestId, provider) => {
      log.info(`Processing request ${requestId} with ${provider}${opts.test ? ' (test mode)' : ''}`);
    });

    bridge.on('request_end', (requestId) => {
      log.info(`Request ${requestId} completed`);
    });

    // -----------------------------------------------------------------------
    // Graceful shutdown
    // -----------------------------------------------------------------------

    const shutdown = async (signal: string) => {
      log.info(`Received ${signal} — shutting down gracefully`);
      await bridge.disconnect();
      closeLogFile();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Unhandled rejections leave the bridge in an unknown state — log, attempt
    // a graceful disconnect, then exit so the operator restarts the process.
    process.on('unhandledRejection', (reason) => {
      log.error('Unhandled rejection — bridge is in an unknown state, exiting (restart the bridge to recover)', {
        error: reason instanceof Error ? reason.message : String(reason),
      });
      // Best-effort disconnect (notify server we're going away)
      bridge.disconnect().catch(() => { /* ignore */ }).finally(() => {
        process.exit(1);
      });
    });

    // -----------------------------------------------------------------------
    // Connect
    // -----------------------------------------------------------------------

    bridge.connect();
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Determine whether this module is being executed directly as the CLI entry
 * point (as opposed to being imported by another module or a test).
 *
 * npm installs the package `bin` entry as a symlink
 * (`node_modules/.bin/ai-bridge` -> `.../dist/cli.js`). When executed,
 * `process.argv[1]` is the *symlink* path while `import.meta.url` resolves to
 * the *real* file path, so a plain string comparison fails and the CLI exits
 * silently without doing anything. Comparing the resolved real paths makes the
 * check symlink-safe. `realpathSync` is wrapped in try/catch because either
 * path may not exist on disk (e.g. argv1 from an unusual launcher).
 *
 * @param argv1     The script path Node was invoked with (`process.argv[1]`).
 * @param moduleUrl This module's URL (`import.meta.url`).
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Guard execution so importing this module does not invoke the CLI.
if (isMainModule(process.argv[1], import.meta.url)) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
