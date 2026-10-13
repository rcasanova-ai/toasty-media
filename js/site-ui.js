// Shared behaviour for the public Toasty Media pages: mobile navigation, subtle scroll reveal.
// No dependencies. Works without JS (content is visible by default; .ts-reveal only hides when JS has run).
(() => {
  document.documentElement.classList.remove("no-js");
  const nav = document.querySelector(".ts-nav");
  const toggle = nav?.querySelector(".ts-nav__toggle");
  if (nav && toggle) {
    const set = (open) => { nav.dataset.open = String(open); toggle.setAttribute("aria-expanded", String(open)); toggle.textContent = open ? "Close" : "Menu"; };
    toggle.addEventListener("click", () => set(nav.dataset.open !== "true"));
    nav.querySelectorAll(".ts-nav__links a, .ts-nav__cta a").forEach((a) => a.addEventListener("click", () => set(false)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
    set(false);
  }
  const items = [...document.querySelectorAll(".ts-reveal")];
  if (!items.length) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) { items.forEach((el) => { el.dataset.in = "true"; }); return; }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.dataset.in = "true"; io.unobserve(entry.target); }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
  items.forEach((el) => io.observe(el));
})();
