// Talks page: switches platform buttons on and lists episodes from talks/shows.json.
// A button is only a link when the JSON holds a real https URL for it; nothing is invented.
(async () => {
  let data;
  try { data = await (await fetch("./shows.json", { cache: "no-cache" })).json(); } catch { return; }
  const isUrl = (u) => typeof u === "string" && /^https:\/\//i.test(u.trim());
  const verb = { youtube: "Watch on YouTube", spotify: "Listen on Spotify", apple: "Listen on Apple Podcasts", x: "Follow on X" };
  const link = (label, href) => {
    const a = document.createElement("a");
    a.className = "platform is-live"; a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = label;
    return a;
  };
  for (const show of data.shows || []) {
    const group = document.querySelector(`[data-show-id="${show.id}"] .platforms`);
    if (group) {
      for (const [key, url] of Object.entries(show.platforms || {})) {
        if (key === "other") continue;
        const slot = group.querySelector(`[data-platform="${key}"]`);
        if (slot && isUrl(url)) slot.replaceWith(link(verb[key] || key, url.trim()));
      }
      const others = (show.platforms?.other || []).filter((o) => isUrl(o?.url) && o.label);
      const otherSlot = group.querySelector('[data-platform="other"]');
      if (others.length) { others.forEach((o) => group.insertBefore(link(o.label, o.url.trim()), otherSlot)); otherSlot?.remove(); }
    }
    const list = document.querySelector(`[data-episodes-list="${show.id}"]`);
    const empty = document.querySelector(`[data-episodes-empty="${show.id}"]`);
    const episodes = (show.episodes || []).filter((e) => e && e.title);
    if (list && episodes.length) {
      for (const ep of episodes) {
        const li = document.createElement("li");
        const title = document.createElement(isUrl(ep.url) ? "a" : "span");
        title.className = "episode__title"; title.textContent = ep.title;
        if (isUrl(ep.url)) { title.href = ep.url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
        li.append(title);
        if (ep.date) { const d = document.createElement("small"); d.textContent = ep.date; li.append(d); }
        if (ep.description) { const p = document.createElement("p"); p.textContent = ep.description; li.append(p); }
        list.append(li);
      }
      if (empty) empty.hidden = true;
    }
  }
})();
