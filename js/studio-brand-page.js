import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js?v=brand-20260916b";

document.addEventListener("DOMContentLoaded", () => {
  const brandTheme = getInitialBrandTheme();
  const brandLink = document.querySelector(".expert-brand");
  const brandLogo = brandLink?.querySelector("img");
  const actions = document.querySelector(".expert-actions");
  const poweredBy = document.createElement("span");
  poweredBy.className = "powered-by expert-powered-by";
  poweredBy.innerHTML = '<span>Powered by</span><img src="../shared/brand/toasty-media/ToastyMediaStudio.png" alt="Toasty Media Studio">';
  actions?.prepend(poweredBy);

  const theme = applyBrandTheme(brandTheme, {
    root: document.body,
    logoImg: brandLogo,
    poweredBy
  });
  const studioUrl = `./director.html?brand=${encodeURIComponent(theme.id)}`;
  if (brandLink) brandLink.href = studioUrl;
  document.querySelectorAll('a[href="./director.html"]').forEach((link) => { link.href = studioUrl; });
  const studioLabel = document.querySelector(".expert-brand-copy small");
  if (studioLabel) studioLabel.textContent = theme.textLogo;
  document.title = `${theme.textLogo} — Guest Finder`;

  if (theme.id !== "toasty") {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (!node.parentElement?.closest(".powered-by")) {
        node.textContent = node.textContent.replace(/\bToasty\b/g, theme.label);
      }
    });
  }
});
