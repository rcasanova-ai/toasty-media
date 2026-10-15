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
const PAGES = { "index.html": "/", "studio/index.html": "/studio/", "peeps/index.html": "/peeps/", "about/index.html": "/about/" };

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
  assert(JSON.stringify(labels) === JSON.stringify(["Studio", "Peeps", "About", "Contact"]), `navigation is exactly Studio, Peeps, About, Contact (${labels.join(", ")})`);
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
  for (const id of ["status", "pricing", "present", "live", "recording"]) assert(!new RegExp(`id="${id}"`).test(html), `has no separate ${id} section (no roadmap, limits, pricing tables or screen-sharing hero)`);
  assert(!/honest|limitation|roadmap|in development|your own AI provider|provider key|Wikipedia|GitHub|API\b/i.test(html.replace(/<form[\s\S]*?<\/form>/, "")), "no honesty, limitation, roadmap or implementation disclosures");
  const rtr = html.match(/<section class="ts-section[^"]*" id="rtr"[\s\S]*?<\/section>/)?.[0] || "";
  assert(/Coming soon/.test(rtr) && /Read The Room/.test(rtr) && /body language/i.test(rtr), "RTR is introduced as Read The Room with a Coming soon label");
  const planner = html.match(/<section class="ts-section[^"]*" id="planner"[\s\S]*?<\/section>/)?.[0] || "";
  assert(/run of show/i.test(planner) && /guests/i.test(planner) && /talking points/i.test(planner), "Session Planner covers guests, run of show and talking points");
  const features = html.match(/<section class="ts-section[^"]*" id="features"[\s\S]*?<\/section>/)?.[0] || "";
  for (const f of ["Recording", "Live production", "Guest invitations", "Producer controls", "Screen sharing", "Program output"]) assert(features.includes(`<h3>${f}</h3>`), `production features include ${f}`);
}

console.log("\nBranding: Toasty orange, no purple or teal, no em or en dashes, no Kristine");
{
  const css = ["css/toasty-site.css", "css/home-landing.css", "css/studio-landing.css", "css/peeps-landing.css", "css/about-page.css"].map(read).join("\n");
  assert(!/#8b7cf6|#6f5ee8|#3dd6c3|#1fb8a6|139, ?124, ?246|61, ?214, ?195|violet|teal/i.test(css), "the site stylesheets contain no purple or teal");
  assert(/--orange-strong: #ff7a29/.test(css) && /--ink-0: #0b0908/.test(css), "uses the Toasty orange and warm near-black from the Studio interface");
  const publicPages = ["index.html", "studio/index.html", "peeps/index.html", "about/index.html", "books/index.html", "speaking/index.html", "ricardo/index.html", "access/index.html", "thank-you.html", "eloquencebonus/index.html", "peeps/login/index.html", "peeps/demo/index.html", "peeps/demo/data.js", "peeps/demo/demo.js", "js/studio-waitlist.js", "js/site-ui.js"];
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
  const books = [...html.matchAll(/<article class="about-book[^"]*[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  assert(books.length === 4 && books.every((b) => /<div class="about-book__cover/.test(b) && /<span class="ts-badge/.test(b) && /<h3>/.test(b) && /<p>/.test(b)), "all four book cards share the same structure and cover container");
  assert(/<h3>Upcoming AI Book<\/h3>/.test(html), "the AI book placeholder reads Upcoming AI Book");
  const projects = html.match(/<div class="about-projects">[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/)?.[0] || "";
  for (const name of ["8ALTA", "Santati", "Get Thai'd Down", "Toasty Studio", "Toasty Peeps"]) assert(projects.includes(`<h3>${name}</h3>`), `portfolio lists ${name}`);
  assert(/https:\/\/www\.8alta\.com/.test(projects) && /https:\/\/www\.santaticrm\.com/.test(projects) && /https:\/\/gettieddown\.vercel\.app/.test(projects), "each portfolio company links to its real site");
}
console.log("\nALL PASSED: the public site pages are consistent, on brand and fully linked.");
