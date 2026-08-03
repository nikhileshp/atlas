// supabase-js v2.112+ expects a native global WebSocket (Node 22+). On
// Node 20 we install `ws` as the implementation. Imported for side effect by
// every Node entrypoint (instrumentation.ts, scripts/seed.ts, tests/setup.ts).
import ws from "ws";

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
}
