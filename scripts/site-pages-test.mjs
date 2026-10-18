#!/usr/bin/env node
// Static contract test for the public site: home, /studio/, /peeps/, /about/.
// Verifies navigation, links and images resolve, the hooks Peeps' scripts need still exist, the Studio waitlist form is
// consent-gated, and — importantly — that the pricing section only states limits the server really enforces and
// invents no prices.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const PAGES = { "index.html": "/", "studio/index.html": "/studio/", "peeps/index.html": "/peeps/", "talks/index.html": "/talks/", "about/index.html": "/about/" };

function targetFile(fromPage, href) {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return fromPage;
  const dir = dirname(join(ROOT, fromPage));
  let file = clean.startsWith("/") ? join(ROOT, clean) : resolve(dir, decodeURI(clean));
  if (/\/$/.test(clean) || !/\.[a-z0-9]+$/i.test(file)) file = join(file, "index.html");
  return file;
}

for (const [page, route] of Object.entries(PAGES)) {
  console.log(`\n${route}`);
  const html = read(page);
  assert(/<title>[^<]{8,}<\/title>/.test(html) && /<meta name="description" content="[^"]{40,}"/.test(html), "has a title and a real meta description");
  assert(/<meta name="viewport" content="width=device-width,initial-scale=1">/.test(html), "has the mobile viewport meta");
  assert(/<html lang="en"/.test(html) && /<a class="ts-skip"/.test(html) && /<main id="main">/.test(html), "has lang, a skip link and a main landmark");
  const nav = html.match(/<nav class="ts-nav__links"[\s\S]*?<\/nav>/)?.[0] || "";
  const labels = [...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
  assert(JSON.stringify(labels) === JSON.stringify(["Studio", "Peeps", "Talks", "About", "Contact"]), `navigation is exactly Studio, Peeps, Talks, About, Contact (${labels.join(", ")})`);
  assert(/css\/toasty-site\.css/.test(html) && /js\/site-ui\.js/.test(html), "uses the shared design system and UI script");
  assert(!/<h1[\s>]/.test(html.replace(/<h1[\s\S]*?<\/h1>/, "")), "exactly one h1");
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  assert(imgs.every((t) => /\balt="/.test(t)), `all ${imgs.length} images have alt text`);
  const refs = [...html.matchAll(/\b(?:href|src)="([^"#][^"]*|#[^"]+)"/g)].map((m) => m[1]).filter((h) => !/^(https?:|mailto:|tel:|data:|javascript:)/.test(h));
  const missing = [];
  for (const ref of refs) {
    if (ref.startsWith("#")) { if (!new RegExp(`id="${ref.slice(1)}"`).test(html)) missing.push(ref); continue; }
    const file = targetFile(page, ref);
    if (!existsSync(file)) { missing.push(ref); continue; }
    const hash = ref.includes("#") ? ref.split("#")[1] : "";
    if (hash && /\.html$/.test(file) && !new RegExp(`id="${hash}"`).test(readFileSync(file, "utf8"))) missing.push(ref);
  }
  assert(missing.length === 0, `every local link, image, stylesheet and anchor resolves${missing.length ? " — MISSING: " + missing.join(", ") : ""}`);
  assert(!/\\n/.test(html), "no literal \\n artifacts");
}

console.log("\nPeeps hooks the existing scripts depend on");
{
  const html = read("peeps/index.html");
  for (const id of ["peepsJoinWaitlist", "peepsOpenApp", "peepsSignInToggle", "peepsSignOut", "peepsAuth", "peepsAuthForm", "peepsAuthEmail", "peepsAuthPassword", "peepsAuthMessage", "peepsAuthClose", "brief", "intent", "context", "find", "resultsWrap", "results", "count", "strong", "dub", "dubBody", "close"]) assert(new RegExp(`id="${id}"`).test(html), `#${id} exists`);
  assert(/class="chip"[^>]*data-brief/.test(html) && /src="\.\/peeps\.js/.test(html) && /peeps-public-auth\.js/.test(html), "scenario chips and both Peeps scripts are still wired");
  assert(/href="\.\/waitlist\/"/.test(html) && /href="\.\/app\/"/.test(html), "waitlist and app routes are preserved");
}

console.log("\nStudio waitlist form");
{
  const html = read("studio/index.html");
  const form = html.match(/<form class="ts-form" id="studioWaitlistForm"[\s\S]*?<\/form>/)?.[0] || "";
  assert(/name="email"[^>]*type="email"|type="email"[^>]*name="email"/.test(form) && /name="name"/.test(form) && /name="interest"/.test(form), "collects name, email and interest");
  assert(/name="consent" required/.test(form) && /unsubscribe at any time/.test(form), "consent is an explicit required checkbox that states what for and how to withdraw");
  assert(/name="website"[^>]*tabindex="-1"/.test(form), "has the hidden bot-trap field");
  const js = read("js/studio-waitlist.js");
  assert(/api\/organizations\/studio-waitlist/.test(js) && !/localStorage|sessionStorage/.test(js), "submits to the server and stores nothing in the browser");
}

console.log("\nStudio is a sales page: one clear call to action, no defensive or technical sections");
{
  const html = read("studio/index.html");
  const ctas = [...html.matchAll(/>Join the Beta Waitlist</g)].length;
  assert(ctas >= 3 && /<button class="ts-btn ts-btn--primary" type="submit" id="swSubmit">Join the Beta Waitlist<\/button>/.test(html), `the primary call to action is Join the Beta Waitlist (${ctas} places, including the form button)`);
  for (const id of ["planner", "moxie", "rtr", "features", "waitlist"]) assert(new RegExp(`<section class="ts-section[^"]*" id="${id}"`).test(html), `has the ${id} section`);
  for (const id of ["status", "pricing", "present", "live", "recording", "gallery"]) assert(!new RegExp(`id="${id}"`).test(html), `has no separate ${id} section (no roadmap, limits, pricing tables or screen-sharing hero)`);
  assert(!/honest|limitation|roadmap|in development|your own AI provider|provider key|Wikipedia|GitHub|API\b|hold to talk|hold-to-talk/i.test(html.replace(/<form[\s\S]*?<\/form>/, "")), "no honesty, limitation, roadmap or implementation disclosures");
  const rtr = html.match(/<section class="ts-section[^"]*" id="rtr"[\s\S]*?<\/section>/)?.[0] || "";
  assert(/Coming soon/.test(rtr) && /Read The Room/.test(rtr) && /body language/i.test(rtr), "RTR is introduced as Read The Room with a Coming soon label");
  const planner = html.match(/<section class="ts-section[^"]*" id="planner"[\s\S]*?<\/section>/)?.[0] || "";
  assert(/run of show/i.test(planner) && /guests/i.test(planner) && /talking points/i.test(planner), "Session Planner covers guests, run of show and talking points");
  const features = html.match(/<section class="ts-section[^"]*" id="features"[\s\S]*?<\/section>/)?.[0] || "";
  for (const f of ["Session planning", "Guest invitations", "Producer controls", "Live recording", "Screen sharing", "Moxie, your AI producer", "Run of show", "Recording downloads"]) assert(features.includes(`<b>${f}</b>`), `the production checklist includes ${f}`);
  assert(!/<figure|<img/.test(features) && !/ts-tile/.test(features), "the production section is a concise checklist, not a card grid or screenshot cluster");
  assert((html.match(/studio-(producer|host|present|moxie|recording|golive)\.jpg/g) || []).length <= 2, "only the stronger screenshots remain on the page");
  const moxie = html.match(/<section class="ts-section[^"]*" id="moxie"[\s\S]*?<\/section>/)?.[0] || "";
  assert(/Hey Moxie/.test(moxie) && /nothing reaches your guests or your audience until you approve/.test(moxie), "Moxie is hands-free by name and keeps results private until approved");
  assert(!/Wikipedia|GitHub|search tool|search box/i.test(moxie), "Moxie is not described as a search tool or tied to named sources");
  assert(/take it off/i.test(moxie) && /share that with everyone/i.test(moxie), "sharing and taking items off screen are explained");
  const planner2 = html.match(/<section class="ts-section[^"]*" id="planner"[\s\S]*?<\/section>/)?.[0] || "";
  assert(/book club/i.test(planner2) && /private invitation/.test(planner2) && /no account/i.test(planner2) && /six steps/.test(planner2), "Session Planner describes the guided steps, guest invitations and the book club template");
}

console.log("\nTalks page");
{
  const html = read("talks/index.html");
  assert(/Toasty Talks &amp; Takes/.test(html) && /Toasty Lit/.test(html), "both launch shows are listed");
  assert(/Conversations, interviews, commentary and opinions about technology, business, culture, current events and interesting people/.test(html), "Talks & Takes has its description");
  assert(/two regular hosts and a rotating guest/.test(html) && /do not need to have read the whole book/.test(html) && /concise briefing/.test(html), "Toasty Lit explains the format and the guest briefing");
  assert(/href="\.\.\/studio\/"/.test(html) && /Produced with Toasty Studio/.test(html), "it says Produced with Toasty Studio and links to the Studio page");
  assert(/href="\.\.\/studio\/#planner"/.test(html), "Toasty Lit connects to Session Planner");
  const platforms = [...html.matchAll(/data-platform="([a-z]+)"/g)].map((m) => m[1]);
  for (const p2 of ["youtube", "spotify", "apple", "x", "other"]) assert(platforms.includes(p2), `has a ${p2} platform button`);
  assert(![...html.matchAll(/<a [^>]*class="[^"]*platform[^"]*"/g)].length && !/youtube\.com|spotify\.com|apple\.com|x\.com|twitter\.com/i.test(html), "no platform button is a link until a real URL exists, and no account is invented");
  const shows = JSON.parse(read("talks/shows.json"));
  const urls = shows.shows.flatMap((sh) => [...Object.values(sh.platforms).flat().map((v) => (typeof v === "string" ? v : v?.url))]).filter(Boolean);
  assert(shows.shows.length === 2 && urls.length === 0 && shows.shows.every((sh) => sh.episodes.length === 0), "the data file holds no invented links or episodes");
  assert(/data-episodes-list="lit"/.test(html) && /data-episodes-list="talks-and-takes"/.test(html) && /talks\.js/.test(html), "each show has an episode listing driven by the data file");
}

console.log("\nPeeps page");
{
  const html = read("peeps/index.html");
  assert(!/described honestly|our roadmap|roadmap/i.test(html), "no defensive beta language or roadmap");
  assert(/Toasty Peeps is in beta\. Join the waitlist and be among the first to experience it\./.test(html), "straightforward beta messaging");
  assert(!/zcash|institutional|confidential settlement|shielded/i.test(html.replace(/<[^>]*>/g, " ")), "Zcash, institutional discretion and confidential settlement are not marketed");
  for (const [value, text] of [["63%", "skills gaps as a major barrier to business transformation"], ["6.1x", "instead of relying on previous job titles"], ["39%", "existing core skills are expected to change by 2030"], ["81%", "moderately or extensively integrated into their AI strategy within 12 to 18 months"]]) {
    assert(new RegExp(`<b>${value.replace(".", "\\.")}</b>[\\s\\S]{0,40}<figcaption>[\\s\\S]*?${text}`).test(html), `statistic ${value} is present with its meaning intact`);
  }
  assert(/weforum\.org\/media\/future-of-jobs-report-2025/.test(html) && /economicgraph\.linkedin\.com\/content\/dam\/me\/economicgraph\/en-us\/PDF\/skills-based-hiring-march-2025\.pdf/.test(html) && /microsoft\.com\/en-us\/worklab\/work-trend-index\/2025-the-year-the-frontier-firm-is-born/.test(html), "each statistic links to its source");
  assert(/Sally/.test(html) && /Steven/.test(html) && /illustrative example, not a statistic/.test(html), "the aptitude example is framed as illustrative");
  for (const term of ["Dubs?", "Dough", "Jams?", "Breadcrumbs"]) assert(new RegExp(`${term}<button type="button" class="ts-term__btn"[^>]*aria-label="What is [^"]+\\?"[^>]*aria-expanded="false"`).test(html), `${term.replace("?", "")} has a keyboard-accessible question-mark explanation`);
  assert(!/id="terms"/.test(html) && !/<h3>(Dub|Dough|Jam|Breadcrumbs?)<\/h3>/.test(html), "there is no glossary section");
  assert(/Personal AI representatives that help people become discoverable/.test(html) && /payment and wallet layer/.test(html) && /Real conversations where people connect/.test(html) && /Evidence and context generated through interactions/.test(html), "the four explanations match the agreed wording");
  assert(/Your expertise has value\./.test(html) && /HTTP 402/.test(html) && /\$0\.01/.test(html) && /10,000 paid accesses a day/.test(html) && /\$100/.test(html) && /not a revenue forecast/.test(html), "the x402 section explains price, the example and the illustrative arithmetic");
  assert(/Colosseum Crypto World’s Fair Hackathon/.test(html) && /colosseum\.com\/arena\/projects\/toasty-peeps/.test(html) && /colosseum\.com\/worldsfair/.test(html) && existsSync(join(ROOT, "site/assets/images/colosseum/crypto-worlds-fair-wordmark.svg")), "the Colosseum section uses the official wordmark and links to the project and the event");
  assert(!/winner|won |award|placed|prize|finalist/i.test(html.match(/<section class="ts-section" id="colosseum"[\s\S]*?<\/section>/)?.[0] || ""), "no awards or placement are claimed");
  const ui = read("js/site-ui.js");
  assert(/Escape/.test(ui) && /aria-expanded/.test(ui) && /ts-term/.test(ui), "tooltips open on tap or click, close on Escape and report their state");
}

console.log("\nBranding: Toasty orange, no purple or teal, no em or en dashes, no Kristine");
{
  const css = ["css/toasty-site.css", "css/home-landing.css", "css/studio-landing.css", "css/peeps-landing.css", "css/about-page.css"].map(read).join("\n");
  assert(!/#8b7cf6|#6f5ee8|#3dd6c3|#1fb8a6|139, ?124, ?246|61, ?214, ?195|violet|teal/i.test(css), "the site stylesheets contain no purple or teal");
  assert(/--orange-strong: #ff7a29/.test(css) && /--ink-0: #0b0908/.test(css), "uses the Toasty orange and warm near-black from the Studio interface");
  const publicPages = ["index.html", "studio/index.html", "peeps/index.html", "about/index.html", "books/index.html", "speaking/index.html", "ricardo/index.html", "access/index.html", "thank-you.html", "eloquencebonus/index.html", "peeps/login/index.html", "peeps/demo/index.html", "peeps/demo/data.js", "peeps/demo/demo.js", "js/studio-waitlist.js", "js/site-ui.js", "talks/index.html", "js/talks.js", "talks/shows.json"];
  for (const page of publicPages) {
    const text = read(page).replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert(!/[\u2013\u2014]/.test(text), `${page} has no em or en dashes`);
    assert(!/Kristine/i.test(text), `${page} does not mention Kristine`);
  }
}

console.log("\nAbout: recognition, uniform book cards, portfolio");
{
  const html = read("about/index.html");
  assert(/Queen Elizabeth II’s Platinum Jubilee Medal \(Alberta\)/.test(html) && /Platinum Jubilee Pin of Her Majesty Queen Elizabeth II/.test(html) && /Federal pin/.test(html), "the Alberta (provincial) medal and the federal pin are listed under Recognition");
  assert([...html.matchAll(/<article class="honour /g)].length === 3 && /jubilee-medal\.jpg/.test(html) && /jubilee-pin\.jpg/.test(html) && /jubilee-certificate\.jpg/.test(html), "Recognition shows the medal, certificate and pin photos in matching cards");
  assert(!/alongside the day job/i.test(html), "no day-job framing");
  assert(/worked for organizations serving government/.test(html) && /worked extensively with government directly/.test(html), "background describes both government-facing organizations and direct government work");
  assert(/based between Thailand and Canada/i.test(html) && !/Bay Area|corridor/i.test(html), "location is Thailand and Canada without corridor references");
  assert(/id="recognition"[\s\S]*?<\/section>\s*<section class="ts-section" id="projects">/.test(html), "portfolio immediately follows Recognition");
  assert(/about-portfolio__section--primary[\s\S]*?Primary ventures/.test(html) && /Products &amp; platforms/.test(html) && /Explorations &amp; R&amp;D/.test(html), "portfolio has primary, product and research sections");
  const cards = [...html.matchAll(/<a class="about-project[^>]*>[\s\S]*?<\/a>/g)].map(m => m[0]);
  assert(cards.length === 8 && cards.every(c => /<div class="about-project__brand/.test(c) && /<h4>/.test(c) && /<p>/.test(c) && /<span class="ts-link">/.test(c)), "all eight portfolio cards have logos, descriptions and links");
  assert(/8ALTA Research/.test(html) && /Santati Embode/.test(html) && /href="https:\/\/slo\.th\//.test(html), "research cards and external links are present");
  const books = [...html.matchAll(/<article class="about-book[^"]*[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  assert(books.length === 4 && books.every((b) => /<div class="about-book__cover/.test(b) && /<span class="ts-badge/.test(b) && /<h3>/.test(b) && /<p>/.test(b)), "all four book cards share the same structure and cover container");
  assert(/<h3>Upcoming AI Book<\/h3>/.test(html), "the AI book placeholder reads Upcoming AI Book");
  for (const name of ["8ALTA", "Santati", "Get Thai'd Down", "Toasty Studio", "Toasty Peeps", "8ALTA Research", "Santati Embode", "slo.th"]) assert(html.includes(`<h4>${name}</h4>`), `portfolio lists ${name}`);
  assert(/https:\/\/8alta\.com\//.test(html) && /https:\/\/santaticrm\.com\//.test(html) && /https:\/\/getthaiddown\.vercel\.app\//.test(html), "each portfolio company links to its real site");
}
console.log("\nALL PASSED: the public site pages are consistent, on brand and fully linked.");
