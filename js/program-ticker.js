export const TICKER_SPEED_MIN = 8;
export const TICKER_SPEED_MAX = 40;
export const TICKER_SPEED_DEFAULT = 16;

const TICKER_MIN_DURATION_SECONDS = 12;
const TICKER_MAX_DURATION_SECONDS = 90;
const TICKER_MIN_DISTANCE_PX = 480;

export function normalizeTickerSpeed(value, fallback = TICKER_SPEED_DEFAULT) {
  const numeric = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : TICKER_SPEED_DEFAULT;
  const next = Number.isFinite(numeric) ? numeric : safeFallback;
  return Math.max(TICKER_SPEED_MIN, Math.min(TICKER_SPEED_MAX, next));
}

export function tickerPixelsPerSecond(speed) {
  const normalized = normalizeTickerSpeed(speed);
  const ratio = (normalized - TICKER_SPEED_MIN) / (TICKER_SPEED_MAX - TICKER_SPEED_MIN);
  return 34 + ratio * 78;
}

export function tickerDurationSeconds({ speed, viewportWidth, textWidth } = {}) {
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const text = Math.max(0, Number(textWidth) || 0);
  const distance = Math.max(TICKER_MIN_DISTANCE_PX, viewport + text);
  const duration = distance / tickerPixelsPerSecond(speed);
  return Math.max(TICKER_MIN_DURATION_SECONDS, Math.min(TICKER_MAX_DURATION_SECONDS, duration));
}
