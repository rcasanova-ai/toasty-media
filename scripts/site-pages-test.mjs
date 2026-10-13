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

console.log("\nStudio pricing is honest");
{
  const html = read("studio/index.html");
  const pricing = html.match(/<section class="ts-section" id="pricing">[\s\S]*?<\/section>/)?.[0] || "";
  assert(!/[$€£]\s?\d|\d\s?(USD|EUR|usd|\/mo)|per month/.test(pricing), "no invented prices appear in the pricing section");
  const server = read("scripts/render-production-server.mjs");
  const plan = (name) => {
    const block = server.match(new RegExp(`\\n  ${name}: Object\\.freeze\\(\\{([\\s\\S]*?)\\n  \\}\\)`))?.[1] || "";
    const n = (key) => Number(block.match(new RegExp(`${key}: (\\d+)`))?.[1]);
    return { people: n("maxParticipants"), sessions: n("maxConcurrentSessions"), members: n("maxMembers") };
  };
  const cards = [...pricing.matchAll(/<article class="ts-plan[^"]*"><h3>(\w+)<\/h3>([\s\S]*?)<\/article>/g)];
  assert(cards.length === 4, "four plans are listed");
  for (const [, name, body] of cards) {
    const p = plan(name.toLowerCase());
    const people = Number(body.match(/Up to (\d+) people/)?.[1]);
    const sessions = Number(body.match(/(\d+) sessions? at a time/)?.[1]);
    const members = Number(body.match(/(\d+) team members?/)?.[1]);
    assert(people === p.people && sessions === p.sessions && members === p.members, `${name}: ${people} people / ${sessions} sessions / ${members} members match the enforced plan limits`);
  }
  assert(!/RTMP|custom domain/i.test(pricing), "unenforced plan features (live-streaming and custom-domain gating) are not advertised as tiers");
}

console.log("\nMoxie claims distinguish available from upcoming");
{
  const html = read("studio/index.html");
  const moxie = html.match(/<section class="ts-section" id="moxie">[\s\S]*?<\/section>/)?.[0] || "";
  assert((moxie.match(/ts-badge--live">Available/g) || []).length === 4 && /ts-badge--soon">Studio chat today/.test(moxie) && /ts-badge--soon">Coming/.test(moxie), "four capabilities are marked Available, the rest are marked as partial or coming");
  assert(/Wikipedia and GitHub today/.test(moxie) && /own AI provider key/.test(moxie) && /waits for your approval/.test(moxie), "research sources, bring-your-own-key and approval-before-air are stated plainly");
}
console.log("\nALL PASSED — public site pages are consistent, honest and fully linked.");
