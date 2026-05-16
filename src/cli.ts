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

import { Command } from 'commander';
import { Bridge, FatalBridgeError } from './bridge.js';
import { detectProviders } from './providers/detector.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeAdapter } from './providers/claude.js';
import { GeminiAdapter } from './providers/gemini.js';
import type { ProviderAdapter } from './providers/base.js';
import { handleTestRequest } from './test-mode.js';
import { setDebug, createLogger } from './utils/logger.js';
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
    'Test mode — respond to AI requests with mock streaming data',
    false,
  )
  .action(async (opts: { token?: string; server?: string; debug: boolean; test: boolean }) => {
    // Enable debug logging if requested
    if (opts.debug) {
      setDebug(true);
    }

    log.info(`AI Bridge v${BRIDGE_VERSION} (protocol v${PROTOCOL_VERSION})`);

    if (opts.test) {
      log.info('Running in TEST MODE — AI requests will receive mock responses');
    }

    // Validate required options
    const token = opts.token;
    const serverUrl = opts.server;

    if (!token) {
      // UX-022: Add actionable guidance on where to obtain the token
      log.error('Authentication token is required. Use --token <token> or set AI_BRIDGE_TOKEN. Generate a token from your web application (see README for details).');
      process.exit(1);
    }

    if (!serverUrl) {
      // UX-022: Add hint about expected URL format
      log.error('Server URL is required. Use --server <url> or set AI_BRIDGE_SERVER. Use the wss:// address provided by your web application (e.g. wss://your-app.com/api/ai-bridge/ws).');
      process.exit(1);
    }

    // Validate server URL format
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      log.error('Server URL must start with ws:// or wss://');
      process.exit(1);
    }

    // BL-013: Warn about unencrypted connections
    if (serverUrl.startsWith('ws://')) {
      // CONS-011: Removed 'WARNING:' prefix — the logger already adds [WRN] label
      log.warn('Connecting over unencrypted ws://. Use wss:// in production.');
    }

    // SEC-006: Reject URLs that contain username/password components to prevent
    // URL authority confusion (e.g. wss://legit.com@attacker.com/ws)
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
    // EFF-001: Use the full provider list (available + unavailable) for the
    // hello message capability declaration; filter separately for the UI check.
    const availableProviders = providers.filter((p) => p.available);

    if (availableProviders.length === 0 && !opts.test) {
      // UX-006: Warn BEFORE connecting so the user understands the bridge is
      // non-functional before it spends time establishing a WebSocket session.
      log.warn('No AI CLI tools detected. The bridge will NOT be able to execute requests.');
      log.warn('Install one of: codex (https://github.com/openai/codex), claude (https://claude.ai/download), gemini (https://github.com/google-gemini/gemini-cli)');
      log.warn('Or use --test flag to run in test mode with mock responses.');
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
    // EFF-002: Run listModels() concurrently across all available providers,
    // consistent with how detectProviders probes are run in parallel.
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
      // UX-006: The pre-connection warning already covers the no-providers case.
      // Removing this redundant second warning (the user was already informed).
    });

    bridge.on('disconnected', (code, reason) => {
      log.warn(`Disconnected from server (code=${code}, reason="${reason}")`);
    });

    bridge.on('error', (err) => {
      log.error('Bridge error', { error: err.message });

      // UX-001: Use typed error instead of string matching to detect fatal errors
      if (err instanceof FatalBridgeError) {
        process.exit(1);
      }
    });

    bridge.on('request_start', (requestId, provider) => {
      log.info(`Processing request ${requestId} with ${provider}${opts.test ? ' (test mode)' : ''}`);
    });

    // UX-020: Use info level so operators can see request completions without
    // enabling --debug.  This makes the log symmetric (start and end are both
    // at info level).
    bridge.on('request_end', (requestId) => {
      log.info(`Request ${requestId} completed`);
    });

    // -----------------------------------------------------------------------
    // Graceful shutdown
    // -----------------------------------------------------------------------

    const shutdown = async (signal: string) => {
      log.info(`Received ${signal} — shutting down gracefully`);
      await bridge.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // UX-021: Unhandled rejections indicate a code bug that left the bridge in
    // an unknown state.  Log the error, attempt a graceful disconnect to flush
    // any in-flight requests, then exit so the operator has a clear signal that
    // the process needs to be restarted.
    process.on('unhandledRejection', (reason) => {
      log.error('Unhandled rejection — bridge may be in a broken state, restarting', {
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

program.parseAsync(process.argv).catch((err: unknown) => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
