// Program Output outro CTA — resolution order is session override -> profile default -> tasteful
// fallback. The resolved end card rides inside the SAME canonical program payload every other piece of
// program state already uses (see LiveSession.canonicalControlState()), so it reaches Program Output
// through the existing server-sync path with no new transport.

export const END_CARD_SOCIAL_PLATFORMS = Object.freeze(["x", "linkedin", "youtube", "instagram", "tiktok", "github", "telegram"]);

export const END_CARD_SOCIAL_LABELS = Object.freeze({
  x: "X",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  github: "GitHub",
  telegram: "Telegram"
});

// Minimal recognizable glyphs (not full brand logos — broadcast-safe single-color marks that read at
// small size), each a self-contained 24x24 viewBox path so they can be inlined without an icon font.
export const END_CARD_SOCIAL_ICONS = Object.freeze({
  x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.9l-5.4-6.9L4.4 22H1.3l8.2-9.3L1 2h7l4.9 6.3L18.9 2Zm-1.2 18h1.9L7.4 4h-2l12.3 16Z"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5.001 2.5 2.5 0 0 1 0-5.001ZM3 9h4v12H3V9Zm7 0h3.8v1.64h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.3c0-1.26-.02-2.88-1.76-2.88-1.76 0-2.03 1.37-2.03 2.79V21h-4V9Z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.5 6.5s-.22-1.56-.9-2.25c-.86-.9-1.82-.9-2.26-.96C16.2 3 12 3 12 3h-.02s-4.2 0-7.34.29c-.44.06-1.4.06-2.26.96-.68.69-.9 2.25-.9 2.25S1.2 8.3 1.2 10.1v1.78c0 1.8.28 3.6.28 3.6s.22 1.56.9 2.25c.86.9 1.99.87 2.5.97C6.7 18.9 12 19 12 19s4.24-.01 7.38-.3c.44-.06 1.4-.06 2.26-.96.68-.69.9-2.25.9-2.25s.28-1.8.28-3.6V10.1c0-1.8-.28-3.6-.28-3.6ZM9.7 13.9V8.6l5.4 2.66-5.4 2.64Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c2.72 0 3.06.01 4.12.06 1.06.05 1.79.22 2.43.47.66.26 1.21.6 1.76 1.15.5.5.9 1.1 1.15 1.76.25.64.42 1.37.47 2.43.05 1.06.06 1.4.06 4.12s-.01 3.06-.06 4.12c-.05 1.06-.22 1.79-.47 2.43a4.9 4.9 0 0 1-1.15 1.76 4.9 4.9 0 0 1-1.76 1.15c-.64.25-1.37.42-2.43.47-1.06.05-1.4.06-4.12.06s-3.06-.01-4.12-.06c-1.06-.05-1.79-.22-2.43-.47a4.9 4.9 0 0 1-1.76-1.15 4.9 4.9 0 0 1-1.15-1.76c-.25-.64-.42-1.37-.47-2.43C2.01 15.06 2 14.72 2 12s.01-3.06.06-4.12c.05-1.06.22-1.79.47-2.43.26-.66.6-1.21 1.15-1.76A4.9 4.9 0 0 1 5.44.54c.64-.25 1.37-.42 2.43-.47C8.94.02 9.28.01 12 .01Zm0 3.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Zm0 10.56a4.16 4.16 0 1 1 0-8.32 4.16 4.16 0 0 1 0 8.32Zm6.65-10.8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" transform="translate(0 1.99)"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 2h-3.3v13.6a2.9 2.9 0 1 1-2.06-2.78V9.4a6.2 6.2 0 1 0 5.36 6.15V9.03a7.9 7.9 0 0 0 4.6 1.47V7.2a4.6 4.6 0 0 1-4.6-4.6V2Z"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.5c.5.1.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 4.5 18.9 19.8c-.2 1-.8 1.2-1.6.75l-4.4-3.24-2.13 2.05c-.24.24-.44.44-.9.44l.32-4.53L18 7.2c.4-.35-.09-.55-.62-.2L7.3 13.17l-4.46-1.4c-.97-.3-.98-.97.2-1.44l17.44-6.72c.8-.3 1.5.2 1.02 1.9Z"/></svg>'
});

export function defaultEndCard() {
  return {
    headline: "THANKS FOR WATCHING",
    message: "",
    website: "toasty.media",
    socials: {},
    showQr: false,
    qrImage: "",
    qrTarget: ""
  };
}

function nonEmpty(endCard) {
  if (!endCard || typeof endCard !== "object") return false;
  return Boolean(
    endCard.headline || endCard.message || endCard.website ||
    (endCard.socials && Object.values(endCard.socials).some(Boolean)) ||
    endCard.qrImage
  );
}

export function sanitizeEndCard(input) {
  const raw = input && typeof input === "object" ? input : {};
  const socials = {};
  const rawSocials = raw.socials && typeof raw.socials === "object" ? raw.socials : {};
  for (const platform of END_CARD_SOCIAL_PLATFORMS) {
    const value = String(rawSocials[platform] || "").trim().slice(0, 300);
    if (value) socials[platform] = value;
  }
  return {
    headline: String(raw.headline || "").trim().slice(0, 120),
    message: String(raw.message || "").trim().slice(0, 400),
    website: String(raw.website || "").trim().slice(0, 300),
    socials,
    showQr: Boolean(raw.showQr),
    qrImage: String(raw.qrImage || "").trim(),
    qrTarget: String(raw.qrTarget || "").trim().slice(0, 300)
  };
}

// session override -> profile default -> tasteful fallback. Each tier is used only if it actually has
// content — an empty override object never masks a real profile default.
export function resolveEndCard({ sessionEndCard, profileEndCard } = {}) {
  if (nonEmpty(sessionEndCard)) return sanitizeEndCard(sessionEndCard);
  if (nonEmpty(profileEndCard)) return sanitizeEndCard(profileEndCard);
  return defaultEndCard();
}

// The QR's effective scan target: an explicit qrTarget override, else the CTA's own website.
export function resolveQrTarget(endCard) {
  return endCard?.qrTarget || endCard?.website || "";
}

export function readImageFileAsDataUrl(file, { maxBytes = 150000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error("No file selected.")); return; }
    if (!/^image\//.test(file.type)) { reject(new Error("QR upload must be an image file.")); return; }
    if (file.size > maxBytes) { reject(new Error(`QR image must be under ${Math.round(maxBytes / 1024)}KB.`)); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}
