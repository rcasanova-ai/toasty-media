import { isTransientFetchError } from "./session-library.js";

const LOCAL_API_ENDPOINT = "http://127.0.0.1:4174";
const PRODUCTION_API_ENDPOINT = "https://render.toasty.media";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function studioRequestOnce(path, options = {}) {
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

// Retries TypeError "Failed to fetch" only — the browser's translation of nginx limit_req 503s that
// carry no Access-Control-* headers (see js/live-session.js SESSION_STATUS_POLL_MS). Application 4xx/5xx
// that DO include CORS become Error(payload.error) and are not retried.
export async function studioRequest(path, options = {}) {
  const { retries, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const attempts = Number.isInteger(retries) ? retries : (method === "GET" ? 4 : 2);
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await studioRequestOnce(path, fetchOptions);
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt === attempts - 1) throw error;
      await delay(400 * (2 ** attempt));
    }
  }
  throw lastError;
}

export function studioApiEndpoint() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") return LOCAL_API_ENDPOINT;
  return window.TOASTY_AUTH_ENDPOINT || PRODUCTION_API_ENDPOINT;
}
