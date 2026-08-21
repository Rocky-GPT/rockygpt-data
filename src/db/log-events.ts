import { EventEmitter } from 'events';

// Global singleton across hot-reloads in Node.js runtime
declare global {
  // eslint-disable-next-line no-var
  var __rockyLogsEmitter: EventEmitter | undefined;
}

if (!global.__rockyLogsEmitter) {
  global.__rockyLogsEmitter = new EventEmitter();
  // Allow multiple browser tabs to connect to SSE stream without warning
  global.__rockyLogsEmitter.setMaxListeners(100);
}

export const logsEmitter: EventEmitter = global.__rockyLogsEmitter;

/**
 * Broadcasts a change event when a chat turn or feedback record is inserted/updated.
 */
export function notifyLogsChanged(): void {
  try {
    logsEmitter.emit('change', { timestamp: Date.now() });
  } catch (err) {
    console.error('Error emitting log change event:', err);
  }
}
