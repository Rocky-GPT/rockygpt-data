import { logsEmitter } from '../../src/db/log-events';
import { eventStream, type ApiHandler } from '../http';


export const getLogsStream: ApiHandler = (request) => {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // 1. Send initial connected event
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`)
      );

      // 2. Listen for database change notifications
      const changeHandler = (payload: { timestamp: number }) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'change', timestamp: payload.timestamp })}\n\n`)
          );
        } catch {
          // Controller might already be closed
        }
      };

      logsEmitter.on('change', changeHandler);

      // 3. Keep-alive heartbeat every 15s to prevent intermediate proxy timeouts
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 15000);

      // 4. Clean up on client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
        logsEmitter.off('change', changeHandler);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });
  return eventStream(stream);
};
