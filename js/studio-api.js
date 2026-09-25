const LOCAL_API_ENDPOINT = "http://127.0.0.1:4174";
const PRODUCTION_API_ENDPOINT = "https://render.toasty.media";

export async function studioRequest(path, options = {}) {
  const response = await fetch(`${studioApiEndpoint()}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.method && options.method !== "GET" ? { "Content-Type": "application/json", "X-Toasty-CSRF": "1" } : {}),
      ...(options.headers || {})
    }
  });
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
