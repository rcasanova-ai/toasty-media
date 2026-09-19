// Toasty's ONE canonical broadcast lower-third/nameplate renderer. Shared today by js/participant-stage.js
// (the reconciler js/live-session.js and js/guest.js both already use identically for their remote-
// participant tiles), and built to be reusable later by Producer Program Preview / the Program Renderer
// once those are wired to ParticipantRegistry composition (they currently are not — see
// js/program-composition.js's own comments — this module doesn't change that).
//
// Visual treatment is NEVER decided here. Every color/radius/shadow this DOM structure uses is a CSS
// custom property (--lower-third-*, --studio-mark-image) that js/brand-themes.js's applyBrandTheme already
// sets per theme (see css/studio.css's own comment on the same tokens) — so a live Host brand change (see
// js/live-session.js's changeBrandTheme) repaints every already-mounted lower third for free, through the
// browser's own CSS custom property inheritance, with no re-render call from this module at all.
//
// PRESENTATION ONLY: reads participant.displayName/title/company (see js/participant-registry.js's shape)
// and nothing else. Never imports VideoEngine, never touches a MediaStreamTrack, never reads or writes
// ParticipantRegistry state — identity data flows in, DOM flows out.

// "Company — Title" — the one hierarchy every surface uses (NAME above, this line below), never reordered
// per-surface. Either half alone if only one is set; "" (caller omits the line entirely) if neither is.
export function formatCompanyTitle({ company, title } = {}) {
  return [company, title].filter(Boolean).join(" — ");
}

// Builds a NEW lower-third node for a participant. tile.appendChild(buildParticipantLowerThird(p)) —
// absolutely positioned by its own CSS (css/studio.css's .lv-lower-third), so it layers over whatever
// video fills the rest of the tile without taking up its own layout space.
export function buildParticipantLowerThird(participant) {
  const wrap = document.createElement("div");
  wrap.className = "lv-lower-third";

  const mark = document.createElement("div");
  mark.className = "lv-lower-third-mark";
  mark.setAttribute("aria-hidden", "true");
  wrap.appendChild(mark);

  const text = document.createElement("div");
  text.className = "lv-lower-third-text";

  const name = document.createElement("div");
  name.className = "lv-lower-third-name";
  name.textContent = participant?.displayName || "Participant";
  text.appendChild(name);

  const roleLine = formatCompanyTitle(participant || {});
  if (roleLine) {
    const role = document.createElement("div");
    role.className = "lv-lower-third-role";
    role.textContent = roleLine;
    text.appendChild(role);
  }

  wrap.appendChild(text);
  return wrap;
}

// Refreshes an ALREADY-MOUNTED lower third's text in place (e.g. presence resolves a fuller profile after
// the tile's first render) without rebuilding the DOM node — keeps js/participant-stage.js's own "only
// append, never reorder/rebuild" tile stability guarantee intact for the lower third too.
export function updateParticipantLowerThird(node, participant) {
  if (!node) return;
  const name = node.querySelector(".lv-lower-third-name");
  if (name) name.textContent = participant?.displayName || "Participant";

  const roleLine = formatCompanyTitle(participant || {});
  const text = node.querySelector(".lv-lower-third-text");
  let role = node.querySelector(".lv-lower-third-role");
  if (roleLine) {
    if (!role) {
      role = document.createElement("div");
      role.className = "lv-lower-third-role";
      text?.appendChild(role);
    }
    role.textContent = roleLine;
  } else if (role) {
    role.remove();
  }
}
