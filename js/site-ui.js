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
  // Term tooltips: hover and keyboard focus are handled in CSS; this adds tap/click toggling, Escape, and keeps the
  // explanation inside the viewport.
  const terms = [...document.querySelectorAll(".ts-term")];
  if (terms.length) {
    const closeAll = (except) => terms.forEach((t) => { if (t !== except) { t.classList.remove("is-open"); t.querySelector(".ts-term__btn")?.setAttribute("aria-expanded", "false"); } });
    const place = (t) => {
      const tip = t.querySelector(".ts-term__tip"); if (!tip) return;
      tip.style.left = "0px";
      const r = tip.getBoundingClientRect();
      const over = r.right - (window.innerWidth - 12);
      if (over > 0) tip.style.left = `${-over}px`;
      if (r.left < 12) tip.style.left = `${12 - r.left}px`;
    };
    terms.forEach((t) => {
      const btn = t.querySelector(".ts-term__btn");
      btn?.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = !t.classList.contains("is-open");
        closeAll(t);
        t.classList.toggle("is-open", open);
        btn.setAttribute("aria-expanded", String(open));
        if (open) place(t);
      });
      t.addEventListener("mouseenter", () => place(t));
      btn?.addEventListener("focus", () => place(t));
    });
    document.addEventListener("click", () => closeAll());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
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
