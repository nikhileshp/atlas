export async function register() {
  // Node runtime only: the edge runtime ships a native WebSocket.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    typeof globalThis.WebSocket === "undefined"
  ) {
    await import("@/lib/ws-polyfill");
  }
}
