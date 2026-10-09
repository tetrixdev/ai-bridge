import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
export const VIEW_URI: string;
export const LISTED_URI: string;
export const VIEW_UI: Record<string, unknown>;
export const LISTED_UI: Record<string, unknown>;
export function makeServer(opts?: { onExit?: () => void }): Server;
