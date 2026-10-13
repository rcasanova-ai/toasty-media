const LOCAL_API_ENDPOINT = "http://127.0.0.1:4174";
const PRODUCTION_API_ENDPOINT = "https://render.toasty.media";

// A network-level failure ("Failed to fetch") is also what the browser reports when the proxy rate-limits or restarts
// (those responses carry no CORS headers). Reads are safe to repeat, so GETs retry briefly before giving up with a
// plain-language message. Writes are never retried automatically.
const RETRY_DELAYS_MS = [700, 1800];

export async function studioRequest(path, options = {}) {
  const isRead = !options.method || options.method === "GET";
  const send = () => fetch(`${studioApiEndpoint()}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.method && options.method !== "GET" ? { "Content-Type": "application/json", "X-Toasty-CSRF": "1" } : {}),
      ...(options.headers || {})
    }
  });
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try { response = await send(); break; }
    catch (error) {
      if (isRead && attempt < RETRY_DELAYS_MS.length) { await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error("Couldn't reach Toasty just now. Check your connection and try again in a moment.");
    }
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Binary or empty responses are handled by callers.
  }
  // Most error responses only ever set `error` (already human-readable — e.g. httpError()'s message).
  // A few (byok_required) also carry a separate, friendlier `message` alongside a short `error` code —
  // prefer that one when it's there so callers surface real guidance instead of a bare code string.
  if (!response.ok) throw new Error(payload.message || payload.error || "Studio request failed.");
  return payload;
}

export function studioApiEndpoint() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") return LOCAL_API_ENDPOINT;
  return window.TOASTY_AUTH_ENDPOINT || PRODUCTION_API_ENDPOINT;
}
