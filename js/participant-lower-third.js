// Toasty's ONE canonical broadcast lower-third/nameplate renderer. Shared by Participant View
// and Program Renderer. Visual treatment is CSS tokens (--lower-third-*, --studio-compact-mark-image).
// PRESENTATION ONLY: identity data in, DOM out. Never hardcodes a person.

export function formatCompanyTitle({ company, title } = {}) {
  return [company, title].filter(Boolean).join(" — ");
}

export function lowerThirdModel(participant = {}, { compactMark = null } = {}) {
  const name = participant?.displayName || "Participant";
  const secondary = formatCompanyTitle(participant || {});
  const mark = compactMark || null;
  return {
    name,
    secondary,
    compactMark: mark,
    hasMark: Boolean(mark)
  };
}

export function buildParticipantLowerThird(participant, options = {}) {
  const model = lowerThirdModel(participant, options);
  const wrap = document.createElement("div");
  wrap.className = "lv-lower-third lv-lower-third--broadcast";

  const rail = document.createElement("div");
  rail.className = "lv-lower-third-rail";
  rail.setAttribute("aria-hidden", "true");
  wrap.appendChild(rail);

  const mark = document.createElement("div");
  mark.className = "lv-lower-third-mark";
  mark.setAttribute("aria-hidden", "true");
  wrap.appendChild(mark);

  const plates = document.createElement("div");
  plates.className = "lv-lower-third-plates";

  const name = document.createElement("div");
  name.className = "lv-lower-third-name";
  name.textContent = model.name;
  plates.appendChild(name);

  if (model.secondary) {
    const role = document.createElement("div");
    role.className = "lv-lower-third-role";
    role.textContent = model.secondary;
    plates.appendChild(role);
  }

  wrap.appendChild(plates);
  return wrap;
}

export function updateParticipantLowerThird(node, participant, options = {}) {
  if (!node) return;
  const model = lowerThirdModel(participant, options);
  const name = node.querySelector(".lv-lower-third-name");
  if (name) name.textContent = model.name;

  const plates = node.querySelector(".lv-lower-third-plates") || node.querySelector(".lv-lower-third-text");
  let role = node.querySelector(".lv-lower-third-role");
  if (model.secondary) {
    if (!role) {
      role = document.createElement("div");
      role.className = "lv-lower-third-role";
      plates?.appendChild(role);
    }
    role.textContent = model.secondary;
  } else if (role) {
    role.remove();
  }
}
