/**
 * CLI Entry Point for @tetrixdev/ai-bridge
 *
 * Parses command-line arguments, detects local AI CLI providers,
 * creates a Bridge instance, and connects to the server.
 *
 * Usage:
 *   npx @tetrixdev/ai-bridge --token <token> --server wss://example.com/bridge
 *   AI_BRIDGE_TOKEN=xxx AI_BRIDGE_SERVER=wss://... npx @tetrixdev/ai-bridge
 */

import { Command } from 'commander';
import { Bridge } from './bridge.js';
import { detectProviders } from './providers/detector.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeAdapter } from './providers/claude.js';
import { GeminiAdapter } from './providers/gemini.js';
import type { ProviderAdapter } from './providers/base.js';
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
  .action(async (opts: { token?: string; server?: string; debug: boolean }) => {
    // Enable debug logging if requested
    if (opts.debug) {
      setDebug(true);
    }

    log.info(`AI Bridge v${BRIDGE_VERSION} (protocol v${PROTOCOL_VERSION})`);

    // Validate required options
    const token = opts.token;
    const serverUrl = opts.server;

    if (!token) {
      log.error('Authentication token is required. Use --token <token> or set AI_BRIDGE_TOKEN.');
      process.exit(1);
    }

    if (!serverUrl) {
      log.error('Server URL is required. Use --server <url> or set AI_BRIDGE_SERVER.');
      process.exit(1);
    }

    // Validate server URL format
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      log.error('Server URL must start with ws:// or wss://');
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Detect providers
    // -----------------------------------------------------------------------

    const providers = await detectProviders();
    const availableProviders = providers.filter((p) => p.available);

    if (availableProviders.length === 0) {
      log.warn('No AI CLI tools detected. The bridge will connect but cannot execute requests.');
      log.warn('Install one of: codex, claude, gemini');
    } else {
      log.info(`Available providers: ${availableProviders.map((p) => `${p.id} (${p.version ?? 'unknown version'})`).join(', ')}`);
    }

    // -----------------------------------------------------------------------
    // Initialize adapters
    // -----------------------------------------------------------------------

    const adapterInstances: ProviderAdapter[] = [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new GeminiAdapter(),
    ];

    const adapters = new Map<string, ProviderAdapter>();
    for (const adapter of adapterInstances) {
      // Only register adapters for providers that are actually available
      const capability = providers.find((p) => p.id === adapter.id);
      if (capability?.available) {
        adapters.set(adapter.id, adapter);
        log.debug('Registered adapter', { id: adapter.id });
      }
    }

    // -----------------------------------------------------------------------
    // Create and connect bridge
    // -----------------------------------------------------------------------

    const bridge = new Bridge({
      serverUrl,
      token,
      providers,
      adapters,
    });

    // Lifecycle logging
    bridge.on('connected', () => {
      log.info('Connected to server');
    });

    bridge.on('welcome', (sessionId) => {
      log.info(`Session established: ${sessionId}`);
    });

    bridge.on('disconnected', (code, reason) => {
      log.warn(`Disconnected from server (code=${code}, reason="${reason}")`);
    });

    bridge.on('error', (err) => {
      log.error('Bridge error', { error: err.message });
    });

    bridge.on('request_start', (requestId, providerId) => {
      log.info(`Processing request ${requestId} with ${providerId}`);
    });

    bridge.on('request_end', (requestId) => {
      log.debug(`Request ${requestId} completed`);
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

    // Unhandled rejection safety net
    process.on('unhandledRejection', (reason) => {
      log.error('Unhandled rejection', {
        error: reason instanceof Error ? reason.message : String(reason),
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
