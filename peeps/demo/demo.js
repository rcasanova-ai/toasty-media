import * as E from './engine.js';
import { PROVENANCE, ACCESS, PRICING, REQUEST_TEXT, PARSED_CRITERIA, REQUESTER, CANDIDATES, INTENTS, JAM, TRANSCRIPT, POST_JAM, EXTERNAL_MATCHES, INVITEE, TRUST_TIERS } from './data.js';

const BUDGET = 10; // seeded demo agent budget for Halcyon Research
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => '$' + (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2));
const usd2 = (n) => '$' + n.toFixed(2);

const params = new URLSearchParams(location.search);
let S = params.has('reset') ? E.resetState(localStorage) : E.loadState(localStorage);
if (params.has('reset')) history.replaceState(null, '', location.pathname);
let token = 0; // cancels in-flight animations when the screen changes
let dubTab = 'identity';
const persist = () => E.saveState(localStorage, S);

const PERSONA = { start: 'Overview', dub: 'Viewing as Sarah · Dub owner', outcome: 'Viewing as Requester', discovery: 'Viewing as Requester', interview: 'Agents working · humans not yet contacted', matches: 'Viewing as Requester', permission: 'Viewing as Sarah', jam: 'Sarah + Requester', studio: 'The human layer', postjam: 'Viewing as Sarah', growth: 'Network view' };
const LABEL = { start: 'Overview', dub: 'Your Dub', outcome: 'Outcome request', discovery: 'Discovery', interview: 'Dub ↔ Dub', matches: 'Qualified matches', permission: 'Human permission', jam: 'Jam', studio: 'Toasty Studio', postjam: 'Post-Jam', growth: 'Network growth' };
const NEXT_LABEL = { start: 'Begin →', dub: 'Continue →', outcome: 'Skip: interpret & find →', discovery: 'Skip: unlock & interview →', interview: 'Skip: finish interview →', matches: 'Skip: request intros →', permission: 'Skip: accept →', jam: 'Skip: join Jam →', studio: 'Skip: end Jam →', postjam: 'Continue →', growth: 'Done' };

const ico = (n) => ({
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
}[n] || '');
const av = (c, cls = '') => `<div class="av ${cls}" style="--h:${c.hue ?? 22}">${esc(c.initials || c.name.split(' ').map((x) => x[0]).join('').slice(0, 2))}</div>`;
const prov = (p) => `<span class="b ${p}" title="${esc(PROVENANCE[p]?.tip || '')}">${esc(PROVENANCE[p]?.label || p)}</span>`;
const acc = (a) => `<span class="b plain" title="${esc(ACCESS[a].tip)}">${esc(ACCESS[a].label)}</span>`;
const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const set = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function go(step) {
  token++; S.step = step; persist(); $('#overlay').hidden = true; render(); window.scrollTo({ top: 0 });
}

async function interlude(title, sub) {
  const o = $('#overlay');
  o.hidden = false;
  o.innerHTML = `<div class="box"><div class="eyebrow">${esc(sub)}</div><h2 class="h1" style="font-size:clamp(30px,5vw,54px)">${esc(title)}</h2><div class="spin" style="margin-top:18px"></div></div>`;
  await sleep(1500);
  o.hidden = true;
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); }

// ------------------------------------------------------------------ chrome
function renderChrome() {
  $('#persona').textContent = PERSONA[S.step] || '';
  const ri = E.railIndex(S);
  $('#rail').innerHTML = E.LIFECYCLE.map((l, i) => `<div class="rn ${i < ri ? 'done' : i === ri ? 'now' : ''}">${esc(l)}</div>`).join('');
  const idx = E.STEPS.indexOf(S.step);
  $('#dockMid').textContent = `${idx + 1} / ${E.STEPS.length} · ${LABEL[S.step]}`;
  $('#nextBtn').textContent = NEXT_LABEL[S.step];
  $('#nextBtn').style.visibility = S.step === 'growth' ? 'hidden' : 'visible';
}

function render() {
  renderChrome();
  const stage = $('#stage');
  const fn = SCREENS[S.step];
  stage.innerHTML = `<section class="screen" data-screen="${S.step}">${fn.html()}</section>`;
  fn.after && fn.after(token);
}

// ------------------------------------------------------------------ screens
const SCREENS = {};

// START ------------------------------------------------------------
SCREENS.start = {
  html: () => `
  <div class="hero">
    <div class="eyebrow">Toasty Peeps · Human context, agent-accessible</div>
    <h1 class="h1">Agents do the qualifying.<br><span style="color:var(--accent2)">Humans do the talking.</span></h1>
    <p class="lead">Every person gets a <b>Dub</b>: a living, permissioned representation of what they know, what they’ll do, and what it costs. Watch an agent find, interview and book the right person, without bothering anyone until it counts.</p>
    <div class="row wrap" style="margin-top:26px"><button class="cta lg" data-act="begin">Begin the demo →</button><span class="tiny">~4 minutes · seeded, deterministic, no live dependencies</span></div>
  </div>
  <div class="phase">
    <div class="col"><h3>① Agent layer</h3>${['Outcome', 'Discovery', 'Context unlock', 'Dub ↔ Dub', 'Qualification'].map((l, i) => `<div class="lc"><i>${i + 1}</i>${l}</div>`).join('')}</div>
    <div class="col human"><h3>② Human layer</h3>${['Permission', 'Jam', 'Studio'].map((l, i) => `<div class="lc"><i>${i + 6}</i>${l}</div>`).join('')}</div>
    <div class="col value"><h3>③ Value layer</h3>${['Payment', 'Breadcrumb', 'Richer Dub', 'Network growth'].map((l, i) => `<div class="lc"><i>${i + 9}</i>${l}</div>`).join('')}</div>
  </div>`,
};

// DUB ---------------------------------------------------------------
const TABS = [['identity', 'Identity'], ['interests', 'Interests'], ['boundaries', 'Boundaries'], ['avail', 'Availability & pricing'], ['evidence', 'Evidence'], ['knowledge', 'Knowledge & access']];
const chipEdit = (label, path, bad) => `<div class="fld"><label>${label}</label><div class="chips">${get(S.dub, path).map((v, i) => `<span class="chip ${bad ? 'bad' : ''}">${esc(v)}<span class="x" data-act="chipdel" data-path="${path}" data-i="${i}">×</span></span>`).join('')}</div><input class="add" placeholder="Add and press Enter" data-chipadd="${path}"></div>`;
const txt = (label, path) => `<div class="fld"><label>${label}</label><input data-bind="${path}" value="${esc(get(S.dub, path))}"></div>`;
const toggle = (label, sub, path) => `<div class="tg" data-act="toggle" data-path="${path}"><div><b>${label}</b><div class="tiny">${sub}</div></div><div class="sw ${get(S.dub, path) ? 'on' : ''}"></div></div>`;
const AGENT_VIEW = { public: 'Sees the claim', dub: 'Reasons over it, evidence cited', paid: 'Pays $0.25 to unlock', permission: 'Must ask Sarah first', private: 'Nothing. Not even the source' };

function dubPane() {
  const p = S.dub.profile;
  switch (dubTab) {
    case 'identity': return `<div class="grid2">${txt('Name', 'profile.name')}${txt('Role', 'profile.role')}</div>${txt('Headline', 'profile.headline')}${txt('Location', 'profile.location')}${chipEdit('Industries', 'profile.industries')}${chipEdit('Expertise', 'profile.expertise')}${chipEdit('Languages', 'profile.languages')}`;
    case 'interests': return `${chipEdit('Topics I care about', 'interests.topics')}${chipEdit('Opportunities I’m open to', 'interests.opportunities')}${chipEdit('People I’d like to meet', 'interests.people')}`;
    case 'boundaries': return `<p class="mut" style="margin-bottom:14px">Your Dub enforces these before anyone reaches you. Matches that cross a boundary are excluded without contacting you.</p>${chipEdit('Topics I do not want', 'boundaries.topics', 1)}${chipEdit('Requests I do not accept', 'boundaries.requests', 1)}${chipEdit('Industries / categories excluded', 'boundaries.industries', 1)}`;
    case 'avail': return `${toggle('Introductions', 'Agents can request an intro, always with your approval', 'availability.introductions')}${toggle('Research conversations', 'Compensated interviews and research Jams', 'availability.research')}${toggle('Advisory', 'Ongoing or one-off advisory calls', 'availability.advisory')}${toggle('Interviews', 'Founder and expert interviews', 'availability.interviews')}${toggle('Focus groups', 'Group sessions', 'availability.focusGroups')}
      <div class="hr"></div><div class="grid3"><div class="card"><div class="lbl">30-minute Jam</div><div class="money">$<input style="width:90px;display:inline;font:inherit;font-weight:900;padding:2px 8px" type="number" min="0" data-bind="pricing.jam30" value="${S.dub.pricing.jam30}"></div></div><div class="card"><div class="lbl">60-minute Jam</div><div class="money">$<input style="width:90px;display:inline;font:inherit;font-weight:900;padding:2px 8px" type="number" min="0" data-bind="pricing.jam60" value="${S.dub.pricing.jam60}"></div></div><div class="card"><div class="lbl">Profile / context unlock</div><div class="money">${usd2(PRICING.contextUnlockUsd)}</div><div class="tiny">Peeps platform standard. Not something you configure.</div></div></div>
      <div class="fld" style="margin-top:16px"><label>Introduction rule</label><input data-bind="pricing.introRule" value="${esc(S.dub.pricing.introRule)}"></div>`;
    case 'evidence': return `<p class="mut" style="margin-bottom:14px">Your Dub only claims what it can back up. Each source is marked <b>connected</b>, <b>uploaded</b> or <b>verified</b>. Everything in this demo is seeded.</p><div class="stack">${S.dub.sources.map((x) => `<div class="src"><div><b>${esc(x.label)}</b><div class="tiny">${esc(x.detail)}</div></div><div class="row">${x.demo ? '<span class="b demoflag plain">Demo data</span>' : ''}<span class="b ${x.state}">${x.state === 'not_connected' ? 'Not connected' : esc(x.state)}</span></div></div>`).join('')}</div>
      <h3 style="margin:22px 0 10px;font-size:18px">Breadcrumbs</h3><div class="stack">${S.dub.breadcrumbs.map((b) => `<div class="src"><div><b>${esc(b.text)}</b><div class="tiny">${esc(b.date)} · ${esc(b.evidence.join(' + '))}</div></div>${prov(b.status)}</div>`).join('')}</div>`;
    case 'knowledge': return `<p class="mut" style="margin-bottom:12px">What your Dub knows, where it came from, and who can see it. Your Dub never invents an answer. No evidence means <b>Unknown</b>, and it can ask you.</p>
      <table><thead><tr><th>Claim</th><th>Provenance</th><th>Access policy</th><th>What an agent gets</th></tr></thead><tbody>${S.dub.knowledge.map((k) => `<tr><td>${k.access === 'private' ? '<span class="redact"></span>' : esc(k.text)}${k.learned ? ' <span class="b verified plain">New</span>' : ''}</td><td>${prov(k.provenance)}</td><td><select class="mini" data-act="access" data-id="${k.id}">${Object.entries(ACCESS).map(([v, a]) => `<option value="${v}" ${k.access === v ? 'selected' : ''}>${a.label}</option>`).join('')}</select></td><td class="tiny">${AGENT_VIEW[k.access]}</td></tr>`).join('')}</tbody></table>
      <div class="chips" style="margin-top:16px">${Object.keys(PROVENANCE).map(prov).join('')}</div>`;
  }
}
SCREENS.dub = {
  html: () => {
    const p = S.dub.profile; const cov = E.coverage(S);
    return `<div class="eyebrow">Act 1 · Create & configure your Dub</div><h1 class="h2">This is Sarah’s Dub.</h1><p class="lead" style="margin-bottom:18px">Not a static profile, and not an omniscient clone. A permissioned representation that knows its evidence, its boundaries and its price.</p>
    <div class="dubgrid"><aside class="card side glow"><div class="row">${av({ name: p.name, hue: 22 }, 'lg')}<div><h3 style="font-size:22px">${esc(p.name)}</h3><div class="mut">${esc(p.role)} · ${esc(p.location)}</div></div></div><p class="mut" style="margin:14px 0">${esc(p.headline)}</p><div class="row"><div class="ring" style="--p:${cov}"><b>${cov}%</b></div><div><b>Context coverage</b><div class="tiny">How much of this Dub is backed by evidence. A profile metric, not a score of a person.</div></div></div><div class="hr"></div><div class="row wrap"><span class="b verified">${S.dub.breadcrumbs.length} Breadcrumbs</span><span class="b self">${S.dub.knowledge.length} claims</span><span class="b plain">${usd(S.dub.pricing.jam60)} / 60 min</span></div></aside>
    <div><div class="tabs">${TABS.map(([id, l]) => `<button class="tab ${dubTab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">${l}</button>`).join('')}</div><div class="card" id="dubPane">${dubPane()}</div></div></div>`;
  },
};

// OUTCOME -----------------------------------------------------------
SCREENS.outcome = {
  html: () => `<div class="eyebrow">Act 2 · Outcome request</div><h1 class="h1">Who do you need<br>in the room?</h1>
  <div class="grid2" style="align-items:stretch;grid-template-columns:1fr auto 1.2fr;gap:20px"><div class="card glow"><div class="lbl">Your outcome, in plain language</div><textarea class="ask" id="ask">${esc(REQUEST_TEXT)}</textarea><div class="row" style="margin-top:14px"><button class="cta" data-act="interpret" ${S.request.parsed ? 'disabled' : ''}>Interpret request</button><span class="tiny">Deterministic interpreter (LLM fallback)</span></div></div>
  <div class="arrow" style="align-self:center">→</div>
  <div class="card"><div class="lbl">What Peeps understood</div><div id="crit" class="crit">${S.request.parsed ? critHtml(false) : '<p class="mut">Structured criteria appear here.</p>'}</div><div id="findWrap" style="margin-top:20px" ${S.request.parsed ? '' : 'hidden'}><button class="cta lg" data-act="find">Find my Peeps →</button></div></div></div>`,
};
const critHtml = (anim) => PARSED_CRITERIA.map((c, i) => `<div class="cr ${c.negative ? 'neg' : ''}" style="animation-delay:${anim ? i * 140 : 0}ms"><small>${c.key}</small><b>${esc(c.value)}</b></div>`).join('');

// DISCOVERY ---------------------------------------------------------
const budgetLeft = () => E.round2(BUDGET - E.contextSpend(S));
function candCard(c) {
  const unl = !!S.unlocked[c.id];
  const why = unl
    ? c.exclusion
      ? `<div class="ctx"><div class="exbanner"><b>Excluded</b>${esc(c.exclusion.reason)}<div class="tiny" style="color:#d9968c;margin-top:3px">${esc(c.exclusion.detail)}</div></div></div>`
      : `<div class="ctx"><div class="chips"><span class="chip">${esc(c.crypto)}</span><span class="b verified">Context confidence · ${esc(c.confidence)}</span></div></div>`
    : `<div class="lock">${ico('lock')} Context locked · private profile, evidence and boundaries</div>`;
  return `<article class="card cand ${c.hero ? 'hl' : ''} ${unl && c.exclusion ? 'ex' : ''}" data-cid="${c.id}"><div class="row sp"><div class="row">${av(c)}<div><b style="font-size:17px">${esc(c.name)}</b><div class="mut" style="font-size:13px">${esc(c.headline)}</div></div></div><div style="text-align:right"><div class="match">${unl && !c.exclusion ? c.contextual : c.surface}%</div><div class="tiny">${unl ? 'contextual' : 'surface'} match</div></div></div>
  <div class="chips"><span class="chip">${esc(c.sector)}</span><span class="chip">${esc(c.raise)}</span><span class="chip ${c.openTo.startsWith('Not') && unl ? 'bad' : ''}">${unl || c.hero ? esc(c.openTo) : 'Research availability'}</span></div>${why}
  ${unl ? '' : `<button class="cta ${c.hero ? '' : 'alt'}" data-act="unlock" data-id="${c.id}">Unlock contextual profile · ${usd2(PRICING.contextUnlockUsd)}</button>`}</article>`;
}
SCREENS.discovery = {
  html: () => `<div class="eyebrow">Act 3–4 · Discovery & context unlock</div><div class="row sp wrap"><h1 class="h2">Why someone matches, not just who they are.</h1><div class="card" style="padding:12px 16px"><div class="tiny">Agent budget (demo)</div><b id="budget">${usd2(budgetLeft())}</b><span class="tiny"> of ${usd2(BUDGET)}</span></div></div>
  <div id="scanwrap">${S.discovery.scanned ? '' : `<div class="scan"><i id="scanbar"></i></div><p class="mut" id="scantxt">Searching the seeded Peeps network…</p><div class="grid4">${'<div class="skel"></div>'.repeat(4)}</div>`}</div>
  <div id="cands" class="grid4" ${S.discovery.scanned ? '' : 'hidden'}>${CANDIDATES.map(candCard).join('')}</div>
  <div id="afterUnlock" style="margin-top:22px" ${S.unlocked.sarah ? '' : 'hidden'}><div class="card glow row sp wrap"><div class="row"><span class="b verified">Context unlocked · ${usd2(PRICING.contextUnlockUsd)}</span><span class="mut">Sarah’s contextual profile is open to your agent. Her Dub will answer before she’s ever contacted.</span></div><button class="cta lg" data-act="interview">Interview Sarah’s Dub →</button></div></div>`,
  async after(t) {
    if (S.discovery.scanned) return;
    const bar = $('#scanbar'); await sleep(60); bar.style.width = '100%'; await sleep(1700); if (t !== token) return;
    $('#scantxt').textContent = '8 plausible candidates found. Context is locked until you authorize.'; await sleep(500); if (t !== token) return;
    S.discovery.scanned = true; persist(); $('#scanwrap').innerHTML = ''; $('#cands').hidden = false;
  },
};

// PAY SHEET ----------------------------------------------------------
async function unlockFlow(id) {
  const c = E.candidate(id); const o = $('#overlay'); o.hidden = false;
  o.innerHTML = `<div class="sheet"><div class="eyebrow">Unlock contextual profile</div><div class="row" style="margin:12px 0">${av(c)}<div><b>${esc(c.name)}</b><div class="mut">${esc(c.headline)}</div></div></div><div class="amt">${usd2(PRICING.contextUnlockUsd)}</div><p class="mut" style="margin:6px 0 16px">Opens evidence-backed context, availability and boundaries for your agent. Sarah’s private material stays private.</p><div class="row sp tiny"><span>Paid from ${esc(REQUESTER.org)} agent budget</span><span>${usd2(budgetLeft())} left</span></div><div class="hr"></div><button class="cta lg" style="width:100%" data-act="authorize" data-id="${id}">Authorize</button><button class="ghost" style="width:100%;margin-top:10px" data-act="closeov">Cancel</button><p class="tiny" style="margin-top:12px">Demo transaction on the x402 / Solana USDC rail interface. Nothing is settled on-chain.</p></div>`;
}
async function authorize(id) {
  const o = $('#overlay'); o.innerHTML = `<div class="sheet" style="text-align:center"><div class="spin"></div><p class="mut" style="margin-top:16px">Authorizing…</p></div>`;
  await sleep(750);
  E.unlockContext(S, id); persist();
  o.innerHTML = `<div class="sheet" style="text-align:center"><div class="okc">✓</div><h3 style="font-size:24px;margin-top:14px">Context unlocked · ${usd2(PRICING.contextUnlockUsd)}</h3></div>`;
  await sleep(850); o.hidden = true;
  if (S.step === 'discovery') {
    const card = $(`[data-cid="${id}"]`); card.outerHTML = candCard(E.candidate(id));
    $('#budget').textContent = usd2(budgetLeft());
    if (S.unlocked.sarah) $('#afterUnlock').hidden = false;
  }
  toast(`Context unlocked · ${usd2(PRICING.contextUnlockUsd)}`);
}

// INTERVIEW ---------------------------------------------------------
const evHtml = (r) => r.evidence?.length ? `<div class="ev"><span class="t">Evidence</span>${r.evidence.map((e) => `<span class="e">${esc(e.label)}</span>`).join('')}</div>` : '';
function msgHtml(r) {
  if (r.who === 'requester') return `<div class="msg req"><small>${esc(REQUESTER.agent)}</small>${esc(r.text)}</div>`;
  const cls = r.kind === 'unknown' ? 'unknown' : r.learned ? 'learned' : '';
  let body = `<div>${esc(r.text)}</div>`;
  if (r.intentId === 'q_comfort') body += `<div class="row" style="margin-top:8px"><span class="b verified plain">60-minute Jam · ${usd(S.dub.pricing.jam60)}</span><span class="b plain">30-minute · ${usd(S.dub.pricing.jam30)}</span></div>`;
  if (r.kind === 'unknown') body += `<div class="ev"><span class="b unknown">Unknown</span></div>` + (r.followUp ? `<div style="margin-top:8px">${esc(r.followUp)}</div>` : '');
  else if (r.kind === 'private') body += `<div class="ev"><span class="b private">Private</span><span class="tiny">Source withheld</span></div>`;
  else body += `<div class="ev">${prov(r.provenance)}${r.learned ? `<span class="tiny">Source: ${esc(r.source)} · Added: ${esc(r.addedAt)}</span>` : ''}</div>` + evHtml(r);
  return `<div class="msg dub ${cls}"><small>${esc(S.dub.profile.name)}’s Dub</small>${body}</div>`;
}
function knowHtml(flashId) {
  return S.dub.knowledge.map((k) => `<div class="kn ${k.id === flashId ? 'flash' : ''} ${k.learned ? 'new' : ''}"><div>${k.access === 'private' ? '<span class="redact"></span>' : esc(k.text)}</div><div style="text-align:right">${prov(k.provenance)}<div class="tiny" style="margin-top:3px">${ACCESS[k.access].label}</div></div></div>`).join('');
}
const phoneHtml = () => {
  const i = INTENTS.find((x) => x.id === 'q_terms');
  if (!S.interview.awaitingClarification && S.interview.learned.length)
    return `<div class="phone"><div class="notch"></div><div class="note" style="text-align:center"><div class="okc" style="width:48px;height:48px;font-size:24px">✓</div><b style="display:block;margin-top:10px">Added to your Dub</b><div class="tiny">Self-attested · Sarah · ${esc(E.today())}</div></div></div>`;
  return `<div class="phone"><div class="notch"></div><div class="note"><div class="tiny">TOASTY PEEPS · now</div><p style="margin:8px 0"><b>Someone evaluating you wants to know:</b></p><p class="mut" style="margin-bottom:6px">${esc(i.clarify.prompt)}</p><div class="ans"><button class="yes" data-act="clarify" data-r="yes">YES</button><button class="no" data-act="clarify" data-r="no">NO</button><button class="ctx2" data-act="ctxopen">ADD CONTEXT</button></div><div id="ctxbox" hidden style="margin-top:10px"><textarea id="ctxnote" rows="3" placeholder="Add context for your Dub"></textarea><button class="cta" style="width:100%;margin-top:8px" data-act="clarify" data-r="context">Send</button></div></div></div>`;
};
SCREENS.interview = {
  html: () => {
    const asked = S.interview.asked; const scriptDone = INTENTS.filter((i) => i.script).every((i) => asked.includes(i.id));
    const learned = S.interview.learned.length > 0;
    return `<div class="eyebrow">Act 5 · Dub ↔ Dub interview</div><h1 class="h2">The agent interviews the Dub<br>before it ever bothers the human.</h1>
    <div class="ivgrid"><div class="card chat"><div class="chat-head"><div class="agents"><div class="node req"><span class="dot">A</span>${esc(REQUESTER.agent)}</div><div class="link"></div><div class="node dub"><span class="dot">D</span>Sarah’s Dub</div></div><span class="b ${S.interview.awaitingClarification || learned ? 'self' : 'verified'} plain" id="humanState">${learned ? 'Sarah answered 1 clarification' : 'Sarah not contacted'}</span></div>
    <div id="log" class="stack" style="display:flex;flex-direction:column;gap:14px">${S.interview.log.map(msgHtml).join('')}</div>
    <div id="ivctl" class="row wrap" style="margin-top:auto">${ivControls()}</div></div>
    <div class="stack"><div id="phoneWrap" ${S.interview.awaitingClarification || learned ? '' : 'hidden'}>${S.interview.awaitingClarification || learned ? phoneHtml() : ''}</div><div class="card"><div class="row sp"><b>What Sarah’s Dub knows</b><span class="tiny">provenance · access</span></div><div id="know">${knowHtml()}</div></div></div></div>`;
  },
};
function ivControls() {
  const asked = S.interview.asked; const scriptIds = INTENTS.filter((i) => i.script).map((i) => i.id);
  const scriptStarted = asked.length > 0; const learned = S.interview.learned.length > 0;
  if (S.interview.awaitingClarification) return `<button class="cta lg" data-act="asksarah">Ask Sarah →</button><span class="tiny">Sarah allows clarification requests.</span>`;
  if (!scriptStarted) return `<button class="cta lg" data-act="play">Start interview</button>`;
  if (learned) return `<button class="cta lg good" data-act="tomatches">See qualified matches →</button>` + INTENTS.filter((i) => !i.script && !asked.includes(i.id)).map((i) => `<button class="ghost" data-act="extra" data-id="${i.id}">Ask: ${esc(i.ask)}</button>`).join('');
  return '';
}
function appendMsg(r) { const l = $('#log'); l.insertAdjacentHTML('beforeend', msgHtml(r)); l.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
async function typing() { const l = $('#log'); l.insertAdjacentHTML('beforeend', '<div class="typing" id="typ"><i></i><i></i><i></i></div>'); await sleep(950); $('#typ')?.remove(); }
async function playAsk(id, t) {
  const before = S.interview.log.length;
  const rec = E.askDub(S, id); persist();
  appendMsg(S.interview.log[before]); await sleep(550); if (t !== token) return rec;
  await typing(); if (t !== token) return rec;
  appendMsg(rec);
  if (rec.claimId) { $('#know').innerHTML = knowHtml(rec.claimId); await sleep(700); if (t !== token) return rec; $('#know').innerHTML = knowHtml(); }
  return rec;
}
async function playInterview() {
  const t = token; $('#ivctl').innerHTML = '<span class="tiny">Agent interviewing…</span>';
  for (const i of INTENTS.filter((x) => x.script && !S.interview.asked.includes(x.id))) {
    const r = await playAsk(i.id, t); if (t !== token) return;
    if (r.kind === 'unknown') break;
    await sleep(500);
  }
  $('#ivctl').innerHTML = ivControls(); $('#humanState').textContent = 'Sarah not contacted yet';
}
async function askSarah() {
  $('#phoneWrap').hidden = false; $('#phoneWrap').innerHTML = phoneHtml();
  $('#humanState').textContent = 'Clarification sent to Sarah'; $('#ivctl').innerHTML = '<span class="tiny">Waiting for Sarah…</span>';
  $('#phoneWrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function answerClarify(r) {
  const t = token; const note = $('#ctxnote')?.value?.trim();
  const claim = E.clarify(S, 'q_terms', r, note); persist();
  $('#phoneWrap').innerHTML = phoneHtml(); $('#humanState').textContent = 'Sarah answered 1 clarification';
  await sleep(700); if (t !== token) return;
  await typing(); if (t !== token) return;
  appendMsg(S.interview.log.at(-1)); $('#know').innerHTML = knowHtml(claim.id); toast('Dub learned something new');
  $('#ivctl').innerHTML = ivControls();
}

// MATCHES -----------------------------------------------------------
function matchCards(sum) {
  return sum.qualified.map((c) => `<article class="card ${c.hero ? 'glow' : ''}"><div class="mc">${av(c, 'lg')}<div><b style="font-size:20px">${esc(c.name)}</b> ${c.seeded ? '<span class="b demoflag plain">Seeded</span>' : ''}<div class="mut">${esc(c.headline)} · ${esc(c.sector)}</div><ul class="rs">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div><div style="text-align:right"><div class="pct">${c.contextual}%</div><div class="tiny">contextual match</div><b>${usd(c.rate)}/hour</b></div></div></article>`).join('');
}
SCREENS.matches = {
  html: () => {
    const done = S.batch.done; const sum = E.batchSummary(S);
    return `<div class="eyebrow">Act 6 · Return matches</div><h1 class="h1" id="mhead">${done ? 'I found 3 strong matches.' : 'Qualifying candidates…'}</h1>
    <div class="grid4" style="margin:12px 0 22px"><div class="stat"><small>Candidates investigated</small><b id="sInv">${done ? sum.investigated : Object.keys(S.unlocked).length}</b></div><div class="stat"><small>Context unlocks</small><b id="sSpend">${usd2(E.contextSpend(S))}</b></div><div class="stat"><small>Qualified</small><b id="sQ">${done ? sum.qualified.length : '–'}</b></div><div class="stat"><small>Excluded</small><b id="sEx">${done ? sum.excluded.length : '–'}</b></div></div>
    <div id="mlist" class="stack" ${done ? '' : 'hidden'}>${done ? matchCards(sum) : ''}<div class="card"><div class="row sp"><b>Excluded by context (${sum.excluded.length})</b><span class="tiny">keyword search would have shown these</span></div>${sum.excluded.map((c) => `<div class="ex-row"><span><b>${esc(c.name)}</b> <span class="mut">· ${c.surface}% surface match</span></span><span style="color:#ffb3a8">${esc(c.exclusion.reason)}</span></div>`).join('')}</div>
    <div class="row sp wrap"><span class="tiny">Introductions require each person’s approval. Nothing is disclosed until they accept.</span><button class="cta lg" data-act="intros">Request introductions →</button></div></div>`;
  },
  async after(t) {
    if (S.batch.done) return;
    const order = CANDIDATES.map((c) => c.id); let n = 0;
    for (const id of order) {
      if (t !== token) return;
      await sleep(420); E.unlockContext(S, id); n++; persist();
      $('#sInv').textContent = n; $('#sSpend').textContent = usd2(E.contextSpend(S));
    }
    const sum = E.runBatchQualification(S); persist(); await sleep(400); if (t !== token) return;
    $('#sQ').textContent = sum.qualified.length; $('#sEx').textContent = sum.excluded.length; $('#mhead').textContent = 'I found 3 strong matches.';
    const ml = $('#mlist'); ml.insertAdjacentHTML('afterbegin', matchCards(sum)); ml.hidden = false;
  },
};

// PERMISSION ---------------------------------------------------------
SCREENS.permission = {
  html: () => {
    const acc = S.intro.accepted;
    return `<div class="eyebrow">Act 7 · Human permission</div><div class="card opp glow stack"><div class="row sp"><span class="b self">New opportunity</span><span class="tiny">Via your Dub · just now</span></div>
    <h1 class="big">${JAM.title}</h1><div class="row wrap"><div><div class="lbl">Requested by</div><b>${esc(REQUESTER.org)}</b> <span class="b demoflag plain">Demo org</span></div><div><div class="lbl">Length</div><b>60 minutes</b></div><div><div class="lbl">Your rate</div><b style="color:var(--green)">${usd(S.dub.pricing.jam60)}</b></div></div>
    <div><div class="lbl">Why you were selected</div><ul class="chk"><li>Founder</li><li>Thailand</li><li>Recent seed raise</li><li>Enterprise SaaS</li><li>Open to research</li></ul></div>
    <p class="mut">Your Dub already completed initial qualification: 5 questions answered, including 1 you clarified yourself. Nothing about you has been shared yet.</p>
    ${acc ? `<div class="card" style="background:rgba(95,211,154,.07);border-color:rgba(95,211,154,.4)"><b style="color:var(--green)">Accepted.</b> <span class="mut">Now sharing only what you permit:</span><div class="chips" style="margin-top:8px">${S.intro.disclosed.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div></div><button class="cta lg good" data-act="createjam">Create the Jam →</button>` : `<div class="row wrap" id="permActs"><button class="cta lg good" data-act="accept">Accept</button><button class="cta alt" data-act="decline">Decline</button><button class="cta alt" data-act="negotiate">Ask my Dub to negotiate</button></div><div id="permNote"></div>`}</div>`;
  },
};

// JAM ---------------------------------------------------------------
SCREENS.jam = {
  html: () => `<div class="eyebrow">Act 8 · Jam</div><div class="card jamcard glow stack"><div class="status">Ready</div><h1 class="big">${JAM.title}</h1><div class="row wrap" style="justify-content:center"><div class="row">${av({ name: 'Sarah Chen', hue: 22 })}<b>Sarah</b></div><span class="dim">+</span><div class="row">${av({ name: 'Ricardo', hue: 200 })}<b>${esc(REQUESTER.name)}</b></div></div>
  <div class="row wrap" style="justify-content:center"><span class="b plain">60 minutes</span><span class="b verified">${usd(JAM.rate)} committed</span><span class="b plain">Recorded · transcribed · with consent</span></div>
  <button class="cta lg" data-act="joinjam">Join Jam →</button><p class="tiny">Funds are held until the Jam completes. Demo ledger entry, no on-chain settlement.</p></div>`,
};

// STUDIO ------------------------------------------------------------
SCREENS.studio = {
  html: () => `<div class="eyebrow">Act 9 · Toasty Studio</div>
  <div class="room"><div class="room-h"><div class="row"><img src="../../shared/brand/toasty-media/ToastyTransparent.png" width="30" alt=""><b>Toasty Studio</b><span class="mut">· ${JAM.title}</span></div><div class="row wrap"><span class="rec" id="recind" style="visibility:${S.studio.consent ? 'visible' : 'hidden'}">REC</span><span class="b verified" id="trind" style="visibility:${S.studio.consent ? 'visible' : 'hidden'}">Live transcription</span><span class="tiny" id="clock">00:00 · demo clock</span></div></div>
  <div class="tiles"><div class="tile" style="--h:22" id="tSarah">${av({ name: 'Sarah Chen', hue: 22 }, 'xl')}<span class="nm">Sarah Chen</span><div class="lv"><i></i><i></i><i></i><i></i><i></i></div></div><div class="tile quiet" style="--h:200" id="tReq">${av({ name: 'Ricardo', hue: 200 }, 'xl')}<span class="nm">${esc(REQUESTER.name)} · ${esc(REQUESTER.org)}</span><div class="lv"><i></i><i></i><i></i><i></i><i></i></div></div></div>
  <div id="moxie"></div><div class="caps" id="caps"><span class="dim">Live captions appear here once recording starts.</span></div>
  <div class="room-f"><span class="tiny">Demo render of a Studio session. The real Studio runs at <a style="color:var(--accent2)" href="../../studio/" target="_blank" rel="noopener">/studio</a>.</span><button class="cta" id="endjam" data-act="endjam" disabled>End Jam</button></div></div>`,
  async after(t) {
    if (!S.studio.consent) {
      const o = $('#overlay'); o.hidden = false;
      o.innerHTML = `<div class="sheet"><div class="eyebrow">Consent</div><h3 style="font-size:24px;margin:8px 0">Record and transcribe this Jam?</h3><p class="mut">Toasty Studio will record audio and video and produce a transcript for both participants.</p><div class="stack" style="margin:16px 0"><div class="row sp"><span>Sarah Chen</span><span class="b verified">Consented</span></div><div class="row sp"><span>${esc(REQUESTER.name)}</span><span class="b self">Waiting for you</span></div></div><button class="cta lg" style="width:100%" data-act="consent">I consent · Start recording</button></div>`;
      return;
    }
    runStudio(t);
  },
};
async function runStudio(t) {
  $('#overlay').hidden = true; $('#recind').style.visibility = 'visible'; $('#trind').style.visibility = 'visible';
  const caps = $('#caps'); caps.innerHTML = ''; let sec = 0;
  const clock = setInterval(() => { sec++; $('#clock') && ($('#clock').textContent = `00:${String(sec).padStart(2, '0')} · demo clock`); }, 1000);
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    if (t !== token) { clearInterval(clock); return; }
    const l = TRANSCRIPT[i]; const sarah = l.who === 'Sarah';
    $('#tSarah').classList.toggle('quiet', !sarah); $('#tReq').classList.toggle('quiet', sarah);
    caps.insertAdjacentHTML('beforeend', `<div class="cap ${sarah ? '' : 'r'}"><small>${l.t}</small><b>${esc(l.who)}</b> ${esc(l.text)}</div>`);
    if (i === 1) $('#moxie').innerHTML = `<div class="moxie"><b>Moxie</b> · Suggested question: “What surprised you most about the process?”</div>`;
    await sleep(2100);
  }
  clearInterval(clock);
  if (t !== token) return;
  $('#endjam').disabled = false; $('#endjam').scrollIntoView({ block: 'nearest' });
}
async function endJam() {
  const o = $('#overlay'); o.hidden = false;
  const steps = ['Finalizing recording', 'Transcribing conversation', 'Summarizing & extracting insights', 'Verifying Studio participation', 'Releasing $25 Dough', 'Creating Breadcrumb'];
  o.innerHTML = `<div class="box"><div class="eyebrow">Jam complete</div><h2 class="h1" style="font-size:clamp(28px,4vw,44px)">Wrapping up…</h2><div class="ps">${steps.map((s) => `<div>${s}</div>`).join('')}</div></div>`;
  const items = o.querySelectorAll('.ps div');
  for (const el of items) { await sleep(480); el.classList.add('on'); }
  E.completeJam(S, { actualMin: 1, demoClock: true }); S.post.stage = 0; persist(); await sleep(500); o.hidden = true;
  go('postjam');
}

// POST-JAM ----------------------------------------------------------
const sigHtml = (tr) => tr.signals.map((s) => `<div class="sig"><i class="${s.status}">${s.status === 'pass' ? '✓' : s.status === 'flag' ? '!' : '~'}</i><div><b>${esc(s.label)}</b><div class="tiny">${esc(s.detail)}</div></div></div>`).join('');
SCREENS.postjam = {
  html: () => {
    const bc = S.dub.breadcrumbs.find((b) => b.id === 'bc_jam_1'); const st = S.post.stage; const tr = S.post.trust;
    const before = E.COVERAGE.base; const after = E.coverage(S);
    const artifacts = `<div class="grid2"><div class="card stack"><div class="row sp"><b>Recording</b><span class="b demoflag plain">Demo clip</span></div><div class="vid"><div class="play">▶</div><div class="wave">${Array.from({ length: 48 }, (_, i) => `<i style="height:${10 + Math.abs(Math.sin(i * 1.7) * 44) + (i % 5) * 2}px"></i>`).join('')}</div></div><div class="tiny">${esc(POST_JAM.durationLabel)}</div></div>
    <div class="card"><div class="row sp"><b>Transcript</b><span class="b demoflag plain">Scripted demo transcript</span></div><div class="tl">${TRANSCRIPT.map((l) => `<div><small>${l.t}</small><b class="${l.who === 'Sarah' ? '' : 'r'}">${esc(l.who)}</b> ${esc(l.text)}</div>`).join('')}</div></div></div>
    <div class="grid3" style="margin-top:16px"><div class="card"><div class="lbl">Summary</div><p class="mut">${esc(POST_JAM.summary)}</p></div><div class="card"><div class="lbl">Key insights</div><ul class="rs">${POST_JAM.insights.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div><div class="card"><div class="lbl">Action items</div><ul class="rs">${POST_JAM.actions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div></div>`;
    return `<div class="eyebrow">Act 10 · After the Jam</div><h1 class="h2">The conversation just paid off.</h1>
    <div class="grid2" style="margin-top:14px"><div class="card glow stack"><div class="lbl">Payment · Dough</div><div class="bigmoney" id="dough">+${usd(S.post.held ? 0 : JAM.rate)}</div><div class="row wrap"><span class="b verified">${S.post.held ? 'Held for review' : 'Settled to Sarah’s Dough'}</span><span class="b demoflag plain">Demo transaction · not settled on-chain</span></div><div class="tiny">Sarah’s Dough balance: <b>${usd2(S.sarahDough)}</b> (demo)</div></div>
    <div class="card stack reveal ${st >= 1 ? 'on' : ''}" id="rvBC"><div class="crumb"><div class="lbl" style="color:var(--green)">New Breadcrumb</div><h3 style="font-size:22px;margin:6px 0 14px">${esc(bc.text)}</h3><div class="row wrap"><span class="b verified">Verified</span><span class="b plain">${esc(bc.date)}</span><span class="b plain">Evidence: ${esc(bc.evidence.join(' + '))}</span></div></div></div></div>
    <div class="card glow reveal ${st >= 2 ? 'on' : ''}" id="rvDub" style="margin-top:16px"><div class="row sp wrap"><div><div class="eyebrow">Richer Dub</div><h2 class="h2" style="margin:4px 0">Your Dub got smarter.</h2></div><div class="ring" style="--p:${st >= 2 ? after : before}" id="pring"><b>${st >= 2 ? after : before}%</b></div></div>
    <div class="row sp tiny" style="margin-top:12px"><span>Context coverage at start of demo: ${before}%</span><span>Now: ${after}%</span></div><div class="bar" style="margin:6px 0 14px"><u style="width:${before}%"></u><i id="cbar" style="width:${st >= 2 ? after : before}%"></i></div>
    <div class="row wrap"><span class="b self plain">+${E.COVERAGE.perLearnedClaim} learned from Sarah’s clarification</span><span class="b verified plain">+${E.COVERAGE.perBreadcrumb} verified Breadcrumb</span><span class="b plain">1 completed Jam</span></div><p class="tiny" style="margin-top:10px">Coverage measures how much of this Dub is backed by evidence. It is a profile metric, not a score of a person.</p></div>
    <h3 style="margin:26px 0 12px;font-size:20px">Session artifacts</h3>${artifacts}
    <div class="card" style="margin-top:16px"><div class="row sp"><b>Trust checks on this payout</b><span class="b ${tr.decision === 'release' ? 'verified' : 'unknown'}">${tr.decision === 'release' ? 'Released' : 'Held'}</span></div>${sigHtml(tr)}</div>
    <div class="row sp wrap" style="margin-top:22px"><span class="tiny">Next: what happens when the person on the other side isn’t a Peep yet.</span><button class="cta lg" data-act="togrowth">Network growth →</button></div>`;
  },
  async after(t) {
    if (S.post.stage >= 2) return;
    const d = $('#dough'); // count-up on payment reveal
    for (let i = 0; i <= 20; i++) { if (t !== token) return; d.textContent = '+$' + Math.round((JAM.rate * i) / 20); await sleep(40); }
    await sleep(900); if (t !== token) return; S.post.stage = 1; persist(); $('#rvBC').classList.add('on'); renderChrome(); toast('Breadcrumb created · Verified');
    await sleep(1800); if (t !== token) return; S.post.stage = 2; persist(); $('#rvDub').classList.add('on'); renderChrome();
    await sleep(500); if (t !== token) return; const a = E.coverage(S); $('#cbar').style.width = a + '%'; $('#pring').style.setProperty('--p', a); $('#pring b').textContent = a + '%';
  },
};

// GROWTH ------------------------------------------------------------
const netSvg = (stage) => {
  const n = [['You', 90, 130, 1], ['Sarah', 230, 70, 1], ['Niran', 230, 190, 0.35], ['Somchai', 380, 100, stage >= 3 ? 1 : 0.25], ['Pim', 380, 180, 0.25], ['+ invited', 520, 130, stage >= 3 ? 0.6 : 0.2]];
  const e = [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5]];
  return `<svg class="net" viewBox="0 0 600 260"><g stroke="var(--line2)" stroke-width="2">${e.map(([a, b]) => `<line x1="${n[a][1]}" y1="${n[a][2]}" x2="${n[b][1]}" y2="${n[b][2]}" ${n[b][3] < 1 ? 'stroke-dasharray="5 5"' : 'stroke="var(--accent)"'}/>`).join('')}</g>${n.map((x) => `<g opacity="${x[3]}"><circle cx="${x[1]}" cy="${x[2]}" r="26" fill="var(--card2)" stroke="${x[3] === 1 ? 'var(--accent)' : 'var(--line2)'}" stroke-width="2"/><text x="${x[1]}" y="${x[2] + 4}" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="800">${x[0]}</text></g>`).join('')}</svg>`;
};
const GSTAGES = 4;
function growthBody() {
  const g = S.growth.stage;
  if (g === 0) return `<div class="msgcard stack"><div class="tiny">TOASTY PEEPS · on behalf of a requester · text / email</div><p><b>Someone is looking for expertise like yours and is willing to pay ${usd(PRICING.externalOfferUsd)} for a one-hour conversation.</b></p><p class="mut">Interested? No account needed to take part.</p><div class="row"><button class="cta good" data-act="gstep">Yes, I’m interested</button><button class="ghost">Not now</button></div><p class="tiny">We never share your details. You decide whether to reply.</p></div>`;
  if (g === 1) return `<div class="msgcard stack"><span class="b verified">Invite accepted</span><h3 style="font-size:22px">Join with a link. No sign-up.</h3><p class="mut">Somchai opens the Studio link on their phone, consents to recording, and talks.</p><div class="row"><button class="cta" data-act="gstep">Simulate: Jam completed →</button></div></div>`;
  if (g === 2) return `<div class="msgcard stack" style="max-width:520px"><div class="eyebrow">You contributed to this Jam</div><h3 style="font-size:26px">Claim your participation and create your Dub.</h3><ul class="rs"><li>Claim your Breadcrumb</li><li>Receive ${usd(PRICING.externalOfferUsd)} compensation</li><li>Control how agents represent you</li><li>Set your boundaries and Jam rate</li><li>Qualify for future opportunities</li></ul><button class="cta lg" data-act="claim">Claim my Dub →</button></div>`;
  const d = S.growth.claimedDub; if (!d) return '';
  return `<div class="msgcard stack" style="max-width:520px;border-color:rgba(95,211,154,.45)"><div class="row">${av(INVITEE, 'lg')}<div><b style="font-size:20px">${esc(d.owner)}’s Dub</b><div class="mut">${esc(d.headline)}</div></div></div><div class="crumb"><div class="lbl" style="color:var(--green)">First Breadcrumb</div><b>${esc(d.breadcrumbs[0].text)}</b><div class="row wrap" style="margin-top:8px"><span class="b verified">Verified</span><span class="b plain">${esc(d.breadcrumbs[0].date)}</span></div></div><div class="row wrap"><span class="b self plain">${usd(d.pendingDoughUsd)} ready to claim</span><span class="b plain">Level 1 · verify payout to release</span></div><p class="tiny">Compensation is released once a payout destination is verified. Trust compounds with each verified Jam.</p></div>`;
}
SCREENS.growth = {
  html: () => `<div class="eyebrow">Act 11–12 · Network growth & cold start</div><h1 class="h2">Peeps works before the network exists.</h1>
  <div class="grid2"><div class="card stack"><div class="lbl">Cold start · not enough internal matches</div><div class="row wrap"><span class="b verified">1 verified Peeps match</span><span class="b self">2 potential external matches</span></div>
  ${EXTERNAL_MATCHES.map((m) => `<div class="src"><div class="row">${av(m)}<div><b>${esc(m.name)}</b> <span class="b plain">Not a Peep yet</span><div class="tiny">${esc(m.headline)} · ${esc(m.note)}</div></div></div></div>`).join('')}<p class="mut">“We found someone who may match your request.” Peeps reaches out through permitted public sources on your behalf. <b>Personal information is never sold or handed over.</b> They decide whether to engage.</p></div>
  <div class="card stack glow"><div class="row sp"><div class="lbl">Non-Peep → Peep · ${esc(INVITEE.name)}</div><span class="tiny">step ${Math.min(S.growth.stage + 1, GSTAGES)} / ${GSTAGES}</span></div><div class="steps">${[0, 1, 2, 3].map((i) => `<i class="${i <= S.growth.stage ? 'on' : ''}"></i>`).join('')}</div>${growthBody()}</div></div>
  <div class="card" style="margin-top:16px"><div class="row sp wrap"><div><div class="lbl">Network</div><b>Every completed Jam can create a new Dub.</b></div><button class="ghost" data-act="reset">Reset the demo ↺</button></div>${netSvg(S.growth.stage)}</div>`,
};

// ------------------------------------------------------------------ drawers
const SOURCES = [
  ['Provenance + access engine, Dub answers', 'real', 'Runs real logic over the seeded evidence: answers only from claims, says Unknown, withholds Private.'],
  ['Trust / payout-hold evaluator', 'real', 'Real decision logic. Session inputs are seeded; see Trust.'],
  ['Ledger arithmetic', 'real', 'Real math. Every entry is flagged demo with settlement: none.'],
  ['Dub profiles, evidence, Breadcrumbs', 'seed', 'Seeded. Stored only in this browser (localStorage key toasty.peeps.demo.v1).'],
  ['Candidates & external matches', 'seed', 'Seeded, fictional people. No network search runs.'],
  ['Outcome interpretation', 'mock', 'Deterministic interpreter standing in for the LLM. Same output every run.'],
  ['Context unlock · x402 / Solana', 'mock', 'Mocked: demo ledger entries only. No RPC call, no wallet, no on-chain settlement.'],
  ['Dough balance & Jam escrow', 'mock', 'Demo ledger. Does not touch real Dough accounts.'],
  ['Toasty Studio room', 'mock', 'Simulated room. Real Studio lives at /studio and is untouched.'],
  ['Recording & transcript', 'mock', 'Scripted demo clip and transcript; no media is captured.'],
];
function drawer(pane) {
  const d = $('#drawer'); d.hidden = false;
  let body = '';
  if (pane === 'sources') body = `<h2 class="h2">Data sources</h2><p class="mut" style="margin-bottom:14px">What is real, what is seeded, what is a mocked fallback.</p>${SOURCES.map(([n, m, t]) => `<div class="src" style="margin-bottom:8px;align-items:flex-start"><div><b>${n}</b><div class="tiny">${t}</div></div><span class="mode ${m}">${{ real: 'REAL LOGIC', seed: 'SEEDED', mock: 'MOCKED' }[m]}</span></div>`).join('')}`;
  if (pane === 'ledger') body = `<h2 class="h2">Demo ledger</h2><p class="mut" style="margin-bottom:14px">Every transaction below is a <b>demo transaction</b>. Nothing settles on-chain.</p>${S.ledger.length ? S.ledger.map((e) => `<div class="src" style="margin-bottom:8px"><div><b>${esc(e.label)}</b><div class="tiny">${esc(e.id)} · ${esc(e.from)} → ${esc(e.to)}</div></div><div style="text-align:right"><b>${usd2(e.amountUsd)}</b><div><span class="mode seed">DEMO</span></div></div></div>`).join('') : '<p class="mut">No transactions yet.</p>'}<div class="hr"></div><div class="row sp"><b>Context unlock spend</b><b>${usd2(E.contextSpend(S))}</b></div><div class="row sp"><b>Sarah’s Dough (demo)</b><b>${usd2(S.sarahDough)}</b></div>`;
  if (pane === 'trust') body = trustPane();
  d.innerHTML = `<div class="row sp"><span></span><button class="ghost" data-act="closedrawer">Close ✕</button></div>${body}`;
}
let trustScn = 'normal';
const SCN = { normal: ['Normal session', {}], dup: ['Duplicate payout destination', { duplicatePayout: true }], fast: ['Impossible completion speed (live clock)', { actualMin: 4, demoClock: false }], rep: ['Repeated participation burst', { repeat24h: 5 }], big: ['$250 Jam on a Level 2 account', { valueUsd: 250 }] };
function trustPane() {
  const tr = E.evaluateTrust({ valueUsd: 25, trustLevel: 2, plannedMin: 60, actualMin: 60, ...SCN[trustScn][1] });
  return `<h2 class="h2">Trust & integrity</h2><p class="mut" style="margin-bottom:14px">Humans are paid, so bots matter. Peeps scores the session, not the person, and trust compounds: the more verified evidence someone accumulates, the less often they’re challenged. No CAPTCHAs.</p>
  <div class="lbl">Try a scenario</div><div class="chips" style="margin-bottom:14px">${Object.entries(SCN).map(([k, [l]]) => `<button class="chip" style="${k === trustScn ? 'border-color:var(--accent)' : ''}" data-act="scn" data-k="${k}">${l}</button>`).join('')}</div>
  <div class="card"><div class="row sp"><b>Decision</b><span class="b ${tr.decision === 'release' ? 'verified' : 'unknown'}">${tr.decision === 'release' ? 'Payout released' : tr.decision === 'hold' ? 'Payment held for review' : 'Step-up verification required'}</span></div>${sigHtml(tr)}</div>
  <h3 style="margin:18px 0 8px;font-size:16px">Progressive verification</h3>${TRUST_TIERS.map((t) => `<div class="src" style="margin-bottom:8px"><div><b>Level ${t.level} · ${t.name}</b><div class="tiny">${t.needs}</div></div><span class="b plain">${t.upTo === Infinity ? '> $100' : 'up to $' + t.upTo}</span></div>`).join('')}`;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  switch (a) {
    case 'begin': return go('dub');
    case 'reset': if (S.step === 'growth' || confirm('Reset the entire demo to its initial state?')) { S = E.resetState(localStorage); token++; $('#drawer').hidden = true; $('#overlay').hidden = true; render(); } return;
    case 'back': { const i = E.STEPS.indexOf(S.step); if (i > 0) go(E.STEPS[i - 1]); return; }
    case 'next': return skip();
    case 'drawer': return drawer(el.dataset.pane);
    case 'closedrawer': $('#drawer').hidden = true; return;
    case 'scn': trustScn = el.dataset.k; return drawer('trust');
    case 'tab': dubTab = el.dataset.tab; document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === dubTab)); $('#dubPane').innerHTML = dubPane(); return;
    case 'chipdel': { const arr = get(S.dub, el.dataset.path); arr.splice(+el.dataset.i, 1); persist(); $('#dubPane').innerHTML = dubPane(); return; }
    case 'toggle': set(S.dub, el.dataset.path, !get(S.dub, el.dataset.path)); persist(); $('#dubPane').innerHTML = dubPane(); return;
    case 'interpret': el.disabled = true; $('#crit').innerHTML = critHtml(true); S.request.parsed = true; persist(); await sleep(PARSED_CRITERIA.length * 140 + 400); $('#findWrap').hidden = false; return;
    case 'find': return go('discovery');
    case 'unlock': return unlockFlow(el.dataset.id);
    case 'authorize': return authorize(el.dataset.id);
    case 'closeov': $('#overlay').hidden = true; return;
    case 'interview': return go('interview');
    case 'play': return playInterview();
    case 'asksarah': return askSarah();
    case 'ctxopen': $('#ctxbox').hidden = false; return;
    case 'clarify': return answerClarify(el.dataset.r);
    case 'extra': { el.remove(); const t = token; await playAsk(el.dataset.id, t); return; }
    case 'tomatches': return go('matches');
    case 'intros': E.requestIntro(S); persist(); await interlude('Switching to Sarah’s view', 'Her Dub has qualified. Now the human decides.'); return go('permission');
    case 'accept': E.acceptIntro(S); persist(); render(); return;
    case 'decline': $('#permNote').innerHTML = '<div class="card" style="margin-top:12px"><b>Declined.</b> <span class="mut">Nothing was shared and the requester sees “not available”. (Demo: use Back or Accept to continue.)</span></div>'; return;
    case 'negotiate': $('#permNote').innerHTML = `<div class="card" style="margin-top:12px"><b>Your Dub checked your rules.</b> <span class="mut">Your 60-minute rate is ${usd(S.dub.pricing.jam60)} and the request meets it. No counter needed. Accept to proceed.</span></div>`; return;
    case 'createjam': E.createJam(S); persist(); return go('jam');
    case 'joinjam': await interlude('Entering Toasty Studio', 'Agents did the qualifying. Now the humans.'); return go('studio');
    case 'consent': S.studio.consent = true; persist(); runStudio(token); return;
    case 'endjam': return endJam();
    case 'togrowth': return go('growth');
    case 'gstep': S.growth.stage++; persist(); render(); return;
    case 'claim': E.claimDub(S); S.growth.stage = 3; persist(); render(); toast('Dub created · first Breadcrumb claimed'); return;
  }
});
document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-bind]'); if (!el) return;
  set(S.dub, el.dataset.bind, el.type === 'number' ? Number(el.value || 0) : el.value); persist();
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-act="access"]'); if (!el) return;
  const k = S.dub.knowledge.find((x) => x.id === el.dataset.id); k.access = el.value; persist(); $('#dubPane').innerHTML = dubPane();
});
document.addEventListener('keydown', (ev) => {
  const el = ev.target.closest?.('[data-chipadd]');
  if (el && ev.key === 'Enter' && el.value.trim()) { get(S.dub, el.dataset.chipadd).push(el.value.trim()); persist(); $('#dubPane').innerHTML = dubPane(); $(`[data-chipadd="${el.dataset.chipadd}"]`)?.focus(); }
});

// "Continue" brings the current step to its completed state so a presenter can always move on.
async function skip() {
  switch (S.step) {
    case 'start': return go('dub');
    case 'dub': return go('outcome');
    case 'outcome': S.request.parsed = true; return go('discovery');
    case 'discovery': S.discovery.scanned = true; E.unlockContext(S, 'sarah'); return go('interview');
    case 'interview': INTENTS.filter((i) => i.script && !S.interview.asked.includes(i.id)).forEach((i) => { const r = E.askDub(S, i.id); if (r.kind === 'unknown') E.clarify(S, i.id, 'yes'); }); return go('matches');
    case 'matches': E.runBatchQualification(S); E.requestIntro(S); await interlude('Switching to Sarah’s view', 'Her Dub has qualified. Now the human decides.'); return go('permission');
    case 'permission': E.acceptIntro(S); E.createJam(S); return go('jam');
    case 'jam': await interlude('Entering Toasty Studio', 'Agents did the qualifying. Now the humans.'); return go('studio');
    case 'studio': S.studio.consent = true; E.completeJam(S, { actualMin: 1, demoClock: true }); S.post.stage = 2; return go('postjam');
    case 'postjam': S.post.stage = 2; return go('growth');
  }
}
document.addEventListener('keydown', (ev) => { if (ev.target.matches?.('input,textarea,select')) return; if (ev.key === 'ArrowLeft') document.querySelector('[data-act=back]').click(); });

render();
