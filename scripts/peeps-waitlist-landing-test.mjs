#!/usr/bin/env node
// Static regression for the Peeps private-beta landing: waitlist CTA + Sign In, no second auth system,
// no public "Judge Login", app gate untouched, homepage reduced to Studio / Peeps / Lit.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
function assert(v, m) { if (!v) throw new Error("FAILED: " + m); console.log("ok - " + m); }

const peeps = read("peeps/index.html");
assert(peeps.includes("Human context, <span>agent-accessible.</span>"), "Peeps narrative headline is unchanged");
assert(/<button[^>]*data-waitlist-open[^>]*>Join the Waitlist<\/button>/.test(peeps), "primary public CTA is Join the Waitlist");
assert(peeps.includes("Peeps is currently in private beta. Join the waitlist for early access."), "private-beta supporting copy is present");
assert(peeps.includes('id="peepsSignInToggle"') && peeps.includes(">Sign in</button>"), "header has a Sign in action");
assert(!/judge/i.test(peeps), "no public Judge Login anywhere on the Peeps landing");
assert(/<h2[^>]*>You’re on the list\.<\/h2>|You’re on the list\./.test(peeps) && peeps.includes("We’ll let you know when your Peeps access is ready."), "success state copy is present");
for (const field of ['name="name"', 'name="email"', 'name="company"', 'name="useCase"', 'name="consent"']) assert(peeps.includes(field), `waitlist form has ${field}`);
assert(/Company \/ organization <em>Optional<\/em>/.test(peeps) && /What are you hoping to use Peeps for\? <em>Optional<\/em>/.test(peeps), "company and use case are optional");
assert(!peeps.includes("peeps-app-gated") && !peeps.includes("peeps-app-gate.js"), "public landing still does not load the app gate");
assert(peeps.includes('href="./app/"'), "Open Peeps still points at the gated app route");
assert(!peeps.includes("Create one in Studio"), "sign-in dialog no longer invites strangers to self-register");

const waitlistJs = read("js/peeps-waitlist.js");
assert(waitlistJs.includes("/api/peeps/waitlist"), "waitlist submits to the persistent API");
assert(!/localStorage|sessionStorage/.test(waitlistJs), "waitlist never stores signups client-side");
assert(waitlistJs.includes("utm_source") && waitlistJs.includes("document.referrer"), "waitlist captures UTM and referrer");
assert(waitlistJs.includes("already_on_list"), "duplicate signups get a friendly confirmation");

const authJs = read("js/peeps-public-auth.js");
assert(authJs.includes('"/auth/login"') && authJs.includes('"/auth/session"'), "Sign in reuses the existing Toasty auth endpoints");
assert(!/\/auth\/register/.test(authJs + waitlistJs), "landing scripts do not create a parallel registration flow");

const admin = read("js/platform-admin.js");
assert(admin.includes("/api/organizations/platform-admin/peeps-waitlist"), "platform admin reads the waitlist through the platform-admin API");
assert(read("studio/platform-admin.html").includes('data-panel-view="waitlist"'), "platform admin has a Peeps waitlist panel");

const home = read("index.html");
const nav = /<nav class="site-nav">(.*?)<\/nav>/s.exec(home)?.[1] || "";
assert(/Studio/.test(nav) && /Peeps/.test(nav) && /Lit/.test(nav), "homepage nav carries Studio, Peeps and Lit");
assert(!/Ricardo|Speaking|Advisory/i.test(nav), "Ricardo is not in the homepage nav");
assert(home.includes('id="studio"') && home.includes('id="peeps"') && home.includes('id="lit"'), "homepage has Studio, Peeps and Lit sections");
assert(home.includes("Studio. Peeps. Lit."), "homepage headline names the three products");
assert(home.includes('href="ricardo/"'), "Ricardo is still reachable (footer) and /ricardo/ is preserved");

console.log("Peeps waitlist landing checks passed.");
