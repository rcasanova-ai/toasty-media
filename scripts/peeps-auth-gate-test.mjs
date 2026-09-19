#!/usr/bin/env node
// Auth-gate contract for /peeps/app/* — no browser, no live backend.
// Run: node scripts/peeps-auth-gate-test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PEEPS_PUBLIC_PATH,
  gatePeepsApp,
  isPeepsAppPath,
  logoutPeeps,
  unauthenticatedAppRedirect
} from "../js/peeps-app-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "peeps/app");
const PUBLIC_PAGE = join(ROOT, "peeps/index.html");
const LOGIN_PAGE = join(ROOT, "peeps/login/index.html");
const WORKFLOW = join(ROOT, ".github/workflows/deploy-production.yml");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("Peeps auth gate — path contract");
assert(isPeepsAppPath("/peeps/app/"), "/peeps/app/ is an app path");
assert(isPeepsAppPath("/peeps/app"), "/peeps/app is an app path");
assert(isPeepsAppPath("/peeps/app/dough.html"), "nested app HTML is an app path");
assert(isPeepsAppPath("/peeps/app/profile.html"), "profile is an app path");
assert(!isPeepsAppPath("/peeps/"), "public sales path is not an app path");
assert(!isPeepsAppPath("/peeps/index.html"), "public index is not an app path");
assert(!isPeepsAppPath("/peeps/login/"), "demo login page is not the gated app route");
assert(!isPeepsAppPath("/studio/"), "Studio is not gated by the Peeps app gate");
assertEqual(unauthenticatedAppRedirect("/peeps/app/"), PEEPS_PUBLIC_PATH, "unauthenticated app → /peeps/");
assertEqual(unauthenticatedAppRedirect("/peeps/app/jams.html"), PEEPS_PUBLIC_PATH, "unauthenticated nested app → /peeps/");
assertEqual(unauthenticatedAppRedirect("/peeps/"), null, "public sales is not redirected by the app gate");

console.log("Peeps auth gate — session decisions (server is source of truth)");

{
  const redirects = [];
  let revealed = false;
  const result = await gatePeepsApp({
    pathname: "/peeps/app/",
    readSession: async () => ({ authenticated: false }),
    redirect: (url) => redirects.push(url),
    reveal: () => { revealed = true; }
  });
  assertEqual(result.authenticated, false, "unauthenticated session does not open the app");
  assertEqual(redirects.join(","), PEEPS_PUBLIC_PATH, "unauthenticated /peeps/app/ redirects to /peeps/");
  assert(!revealed, "unauthenticated visit does not reveal the app shell");
}

{
  const redirects = [];
  let revealed = false;
  const result = await gatePeepsApp({
    pathname: "/peeps/app/dough.html",
    readSession: async () => ({ authenticated: true, user: { name: "Ricardo" } }),
    redirect: (url) => redirects.push(url),
    reveal: () => { revealed = true; }
  });
  assertEqual(result.authenticated, true, "authenticated session opens the app");
  assertEqual(result.user.name, "Ricardo", "authenticated user is passed through");
  assertEqual(redirects.join(","), "", "authenticated visit does not redirect");
  assert(revealed, "authenticated visit reveals the app shell");
}

{
  const redirects = [];
  const result = await gatePeepsApp({
    pathname: "/peeps/app/",
    readSession: async () => { throw new Error("auth unreachable"); },
    redirect: (url) => redirects.push(url),
    reveal: () => {}
  });
  assertEqual(result.authenticated, false, "auth-service failure is fail-closed");
  assertEqual(redirects.join(","), PEEPS_PUBLIC_PATH, "auth-service failure redirects to /peeps/");
}

{
  const redirects = [];
  let revealed = false;
  await gatePeepsApp({
    pathname: "/peeps/",
    readSession: async () => ({ authenticated: false }),
    redirect: (url) => redirects.push(url),
    reveal: () => { revealed = true; }
  });
  assertEqual(redirects.join(","), "", "gate function does not bounce the public sales page");
  assert(!revealed, "public sales page is not 'revealed' by the app gate");
}

{
  const redirects = [];
  await logoutPeeps({
    request: async () => ({ authenticated: false }),
    redirect: (url) => redirects.push(url)
  });
  assertEqual(redirects.join(","), PEEPS_PUBLIC_PATH, "logout leaves the app for /peeps/");
}

{
  const redirects = [];
  await logoutPeeps({
    request: async () => { throw new Error("already logged out"); },
    redirect: (url) => redirects.push(url)
  });
  assertEqual(redirects.join(","), PEEPS_PUBLIC_PATH, "logout still redirects if the API is unreachable");
}

console.log("Peeps auth gate — HTML wiring");

const publicHtml = readFileSync(PUBLIC_PAGE, "utf8");
assert(!publicHtml.includes("peeps-app-gated"), "public /peeps/ is not fail-closed hidden");
assert(!publicHtml.includes("peeps-app-gate.js"), "public /peeps/ does not load the app gate");
assert(publicHtml.includes("Find your"), "public sales copy remains on /peeps/");
assert(publicHtml.includes("peeps-public-auth.js"), "public /peeps/ offers Studio sign-in without gating the page");
assert(publicHtml.includes('href="./app/"'), "Open Peeps still points at the app route (the gate protects it)");

const loginHtml = readFileSync(LOGIN_PAGE, "utf8");
assert(!loginHtml.includes("No password required"), "demo login no longer claims passwordless app access");

const appFiles = readdirSync(APP_DIR).filter((name) => name.endsWith(".html"));
assert(appFiles.length >= 11, `expected the Peeps app HTML set, found ${appFiles.length}`);
for (const name of appFiles) {
  const html = readFileSync(join(APP_DIR, name), "utf8");
  assert(html.includes("peeps-app-gated"), `${name} fail-closes the app shell pending session`);
  assert(html.includes("peeps-app-gate.js"), `${name} loads the session gate`);
  assert(html.includes('url=/peeps/'), `${name} sends no-JS visitors to /peeps/`);
}

const gateSource = readFileSync(join(ROOT, "js/peeps-app-gate.js"), "utf8");
assert(!/\blocalStorage\s*[.\[]/.test(gateSource), "app gate does not read localStorage auth state");
assert(gateSource.includes("/auth/session"), "app gate uses the existing Studio session endpoint");

const workflow = readFileSync(WORKFLOW, "utf8");
assert(workflow.includes("peeps-app-gate.js"), "production verify checks that /peeps/app/ is gated");
assert(workflow.includes("https://toasty.media/peeps/"), "production verify still checks the public sales page");

console.log("\nAll peeps auth-gate checks passed.");
