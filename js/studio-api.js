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
  if (!response.ok) throw new Error(payload.error || "Studio request failed.");
  return payload;
}

export function studioApiEndpoint() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") return LOCAL_API_ENDPOINT;
  return window.TOASTY_AUTH_ENDPOINT || PRODUCTION_API_ENDPOINT;
}
