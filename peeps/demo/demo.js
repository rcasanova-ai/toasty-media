import * as E from './engine.js';
import { PROVENANCE, ACCESS, PRICING, REQUEST_TEXT, PARSED_CRITERIA, REQUESTER, CANDIDATES, INTENTS, DAVID_DUB, DAVID_INTENTS, INVESTIGATION_ORDER, INVESTIGATION_BUDGET_USD, JAM, TRANSCRIPT, POST_JAM, EXTERNAL_MATCHES, INVITEE, TRUST_TIERS, SARAH_DUB } from './data.js';

// The human does three things: describe the outcome, authorize introductions, join the Jam.
// Everything in between is performed on screen by the Peeps agent from seeded, deterministic data.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => '$' + (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2));
const usd2 = (n) => '$' + n.toFixed(2);

const SPEEDS = { pitch: 1.25, normal: 2.2 }; // deterministic pacing multipliers
const SPEED_KEY = 'toasty.peeps.demo.speed';
let speed = 'pitch';
try { speed = localStorage.getItem(SPEED_KEY) === 'normal' ? 'normal' : 'pitch'; } catch { /* default */ }

const params = new URLSearchParams(location.search);
let S = params.has('reset') ? E.resetState(localStorage) : E.loadState(localStorage);
if (params.has('reset')) history.replaceState(null, '', location.pathname);
let token = 0; // bumped on every render/reset; cancels in-flight agent runs
const CANCEL = Symbol('cancel');
let dubTab = 'identity';
const persist = () => E.saveState(localStorage, S);
const mkWait = (t) => async (ms) => { await sleep(ms * SPEEDS[speed]); if (t !== token) throw CANCEL; };
const guarded = async (fn) => { try { await fn(); } catch (e) { if (e !== CANCEL) console.error(e); } };

const PERSONA = { compose: 'You → your agent', understand: 'Agent working', discover: 'Agent working', investigate: 'Agent ↔ Dubs', qualify: 'Agent working', shortlist: 'Agent → you', approach: 'Agent ↔ Dubs', ready: 'Sarah accepted', studio: 'The human layer', wrapup: 'Agent resuming', results: 'Viewing as Sarah', growth: 'Network view' };
const SHORT_REASON = { tom: 'Geography mismatch', anong: 'Seed raise outside requested window', mei: 'Not open to research', kittipong: 'Insufficient evidence', david: 'Strong keyword match, poor contextual match' };

const av = (c, cls = '') => `<div class="av ${cls}" style="--h:${c.hue ?? 22}">${esc(c.initials || c.name.split(' ').map((x) => x[0]).join('').slice(0, 2))}</div>`;
const prov = (p) => `<span class="b ${p}" title="${esc(PROVENANCE[p]?.tip || '')}">${esc(PROVENANCE[p]?.label || p)}</span>`;
const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const set = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function enter(phase) { S.phase = phase; persist(); render(); window.scrollTo({ top: 0 }); }
function setPhase(phase) { S.phase = phase; persist(); renderChrome(); }
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); }
async function interlude(title, sub, ms = 1700) {
  const o = $('#overlay'); o.hidden = false;
  o.innerHTML = `<div class="box"><div class="eyebrow">${esc(sub)}</div><h2 class="h1" style="font-size:clamp(30px,5vw,54px)">${esc(title)}</h2><div class="spin" style="margin-top:18px"></div></div>`;
  await sleep(ms * SPEEDS[speed]); o.hidden = true;
}

function renderChrome() {
  $('#persona').textContent = PERSONA[S.phase] || '';
  const ri = E.railIndex(S);
  $('#rail').innerHTML = E.LIFECYCLE.map((l, i) => `<div class="rn ${i < ri ? 'done' : i === ri ? 'now' : ''}">${esc(l)}</div>`).join('');
  $('#spPitch').classList.toggle('on', speed === 'pitch'); $('#spNormal').classList.toggle('on', speed === 'normal');
}

function render() {
  token++;
  renderChrome();
  const v = VIEWS[S.phase] || VIEWS.compose;
  $('#stage').innerHTML = `<section class="screen" data-screen="${S.phase}">${v.html()}</section>`;
  if (v.start) { const t = token; guarded(() => v.start(t, mkWait(t))); }
}
const VIEWS = {};

// ------------------------------------------------------------------ 1. compose (human action #1)
VIEWS.compose = {
  html: () => `<div class="compose"><div class="eyebrow">Toasty Peeps · Agents change how humans can be discovered</div>
    <h1 class="h1">Tell your agent<br><span style="color:var(--accent2)">who you need.</span></h1>
    <div class="card glow" style="text-align:left"><div class="lbl">Your outcome, in plain language</div><div class="ask ask-locked" id="ask" role="note" aria-readonly="true">${esc(REQUEST_TEXT)}</div>
    <div style="margin-top:16px;text-align:right"><button class="cta xl" data-act="find">Find my Peeps →</button></div></div></div>`,
};

// ------------------------------------------------------------------ agent workspace
const POOL_SECTIONS = [['queued', 'Discovered'], ['inv', 'Investigating'], ['q', 'Qualified'], ['x', 'Excluded']];
function poolCard(c) {
  const st = S.pool?.[c.id]; if (!st) return '';
  const right = st === 'queued' ? `${c.surface}%` : st === 'inv' ? '<span class="tiny">…</span>' : st === 'q' ? `${c.contextual}%` : esc(c.exclusion.reason);
  return `<div class="pc ${st === 'queued' ? '' : st} ${S.jams?.[c.id] ? 'booked' : ''}" data-pid="${c.id}">${av(c)}<div><div class="nm">${esc(c.name)}</div><div class="sb">${esc(c.headline)}</div></div><div class="pr">${right}</div></div>`;
}
function poolHtml() {
  S.pool = S.pool || {};
  return POOL_SECTIONS.map(([k, l]) => `<div><div class="pool-h"><span>${l}</span><b id="cnt-${k}">${CANDIDATES.filter((c) => S.pool[c.id] === k).length}</b></div><div id="pool-${k}">${CANDIDATES.filter((c) => S.pool[c.id] === k).map(poolCard).join('')}</div></div>`).join('');
}
function moveCard(id, st) {
  S.pool = S.pool || {}; S.pool[id] = st; persist();
  const c = E.candidate(id); $(`[data-pid="${id}"]`)?.remove();
  $(`#pool-${st}`)?.insertAdjacentHTML('beforeend', poolCard(c));
  POOL_SECTIONS.forEach(([k]) => { const n = $(`#cnt-${k}`); if (n) n.textContent = CANDIDATES.filter((x) => S.pool[x.id] === k).length; });
  $('#pool-' + st)?.lastElementChild?.scrollIntoView({ block: 'nearest' });
}
function updBudget() {
  const sp = E.contextSpend(S); const el = $('#spent'); if (!el) return;
  el.textContent = usd2(sp); $('#meterfill').style.width = Math.min(100, (sp / INVESTIGATION_BUDGET_USD) * 100) + '%';
}
function updIntro() { const el = $('#introAmt'); if (el) el.textContent = usd2(E.jamReserved(S)); }
function addHtml(html) { const f = $('#feed'); if (!f) return null; f.insertAdjacentHTML('beforeend', html); const el = f.lastElementChild; f.scrollTop = f.scrollHeight; return el; }
const addLine = (text, cls = '') => addHtml(`<div class="fl ${cls}">${text}</div>`);
const live = (txt, done) => { const el = $('#livechip'); if (el) { el.textContent = txt; el.classList.toggle('done', !!done); } };

function workspaceHtml() {
  const approach = S.phase === 'approach';
  return `<div class="ws"><aside class="ws-left"><div class="card"><div class="lbl">Goal</div><p style="font-size:15px">${esc(REQUEST_TEXT)}</p><div class="hr"></div><div class="lbl">Understood as</div><div class="crit-l" id="critl"></div></div>
    <div class="card"><div class="lbl">Investigation</div><div class="row sp"><span class="spent" id="spent">${usd2(E.contextSpend(S))}</span><span class="tiny">Budget ${usd2(INVESTIGATION_BUDGET_USD)}</span></div><div class="meter"><i id="meterfill" style="width:${(E.contextSpend(S) / INVESTIGATION_BUDGET_USD) * 100}%"></i></div><div class="tiny">Context bought by your agent · x402 / Solana USDC · DEMO</div></div>
    <div class="card" id="introCard" ${approach ? '' : 'hidden'}><div class="lbl">Introductions authorized</div><div class="row sp"><span class="spent" id="introAmt">${usd2(E.jamReserved(S))}</span><span class="tiny">of ${usd(E.introTotal())} reserved</span></div></div></aside>
  <section class="card" style="padding:16px 16px 6px"><div class="wsh"><span>Peeps Agent</span><span class="tiny">for ${esc(REQUESTER.org)}</span><span class="live" id="livechip" style="margin-left:auto">Working</span></div><div class="hr"></div><div class="feed" id="feed"></div></section>
  <aside class="ws-right"><div class="card"><div class="lbl" style="margin-bottom:6px">Candidate pool</div><div id="pool">${poolHtml()}</div></div></aside></div>`;
}
const critLine = (c) => { const l = $('#critl'); if (l) l.insertAdjacentHTML('beforeend', `<div class="${c.negative ? 'neg' : ''}">${esc(c.key)}: ${esc(c.value)}</div>`); };

// conversation card -------------------------------------------------
function openConvo(c, dubName) {
  const el = addHtml(`<div class="convo"><div class="convo-h">${av(c)}<div><b>Peeps Agent ↔ ${esc(dubName)}</b></div></div><div class="msgs"></div></div>`);
  return el.querySelector('.msgs');
}
const evChips = (r) => r.evidence?.length ? `<div class="ev"><span class="t">Evidence</span>${r.evidence.map((e) => `<span class="e">${esc(e.label)}</span>`).join('')}</div>` : '';
function dubBubble(name, r, intent) {
  const cls = r.kind === 'unknown' ? 'unknown' : r.learned ? 'learned' : '';
  let body = `<div>${esc(r.text)}</div>`;
  if (intent?.attachRate && r.kind === 'answer') body += `<div class="row" style="margin-top:8px"><span class="b verified plain">60-minute Jam · ${usd(S.dub.pricing.jam60)}</span></div>`;
  if (r.kind === 'unknown') body += `<div class="ev"><span class="t">Confidence</span><span class="b unknown">Unknown</span></div>${r.followUp ? `<div style="margin-top:8px">${esc(r.followUp)}</div>` : ''}`;
  else if (r.kind === 'private') body += `<div class="ev"><span class="b private">Private</span></div>`;
  else body += `<div class="ev"><span class="t">Confidence</span>${prov(r.provenance)}${r.learned ? `<span class="tiny">Source: ${esc(r.source)} · Added: ${esc(r.addedAt)}</span>` : ''}</div>${evChips(r)}`;
  return `<div class="msg dub ${cls}"><small>${esc(name)}</small>${body}</div>`;
}
async function say(msgs, who, html, wait, typingMs = 650) {
  if (!msgs) return;
  const f = $('#feed');
  if (who !== 'agent') { msgs.insertAdjacentHTML('beforeend', '<div class="typing" id="typ"><i></i><i></i><i></i></div>'); if (f) f.scrollTop = f.scrollHeight; await wait(typingMs); $('#typ')?.remove(); }
  msgs.insertAdjacentHTML('beforeend', html); if (f) f.scrollTop = f.scrollHeight;
  await wait(who === 'agent' ? 450 : 650);
}
const agentMsg = (text) => `<div class="msg req"><small>Peeps Agent</small>${esc(text)}</div>`;
const sysNote = (msgs, text) => { msgs?.insertAdjacentHTML('beforeend', `<div class="sysnote">${text}</div>`); const f = $('#feed'); if (f) f.scrollTop = f.scrollHeight; };

async function unlockSeq(c, wait) {
  addLine('Additional context required.', 'dim');
  const m = addHtml(`<div class="spend"><div class="spin"></div><div><div class="amt2">${usd2(PRICING.contextUnlockUsd)}</div><div class="rail2">x402 / Solana USDC · DEMO</div></div><div class="st" style="color:var(--gold)">Authorizing context unlock…</div></div>`);
  await wait(650);
  const e = E.unlockContext(S, c.id); persist(); updBudget();
  if (m) { m.classList.add('done'); m.innerHTML = `<div class="okc" style="width:28px;height:28px;font-size:16px;margin:0">✓</div><div><div class="amt2">${usd2(PRICING.contextUnlockUsd)}</div><div class="rail2">x402 / Solana USDC · DEMO</div></div><div class="st">Context unlocked${e ? ` · ${esc(e.id)}` : ''}</div>`; }
  await wait(400);
}
const verdictHtml = (ok, c, lines) => `<div class="verdict ${ok ? 'q' : 'x'}"><b class="t">${ok ? '✓ QUALIFIED' : '✕ EXCLUDED'}</b><div>${lines}</div></div>`;

async function investigateDavid(c, wait) {
  addLine(`${esc(c.name)}`, 'head');
  addLine(`Initial match: <b>${c.surface}%</b> · strong on keywords`, 'sub');
  await wait(500);
  await unlockSeq(c, wait);
  addLine(`Contacting ${esc(c.name.split(' ')[0])}’s Dub…`, 'dim'); await wait(500);
  const msgs = openConvo(c, 'David’s Dub');
  for (const it of DAVID_INTENTS) {
    await say(msgs, 'agent', agentMsg(it.ask), wait);
    await say(msgs, 'dub', dubBubble('David’s Dub', { who: 'dub', ...E.answerFromDub(DAVID_DUB, it) }), wait);
  }
  await say(msgs, 'agent', agentMsg('The request explicitly excludes crypto.'), wait);
  const v = `<div class="verdict x"><b class="t">✕ EXCLUDED</b><div><b>Reason:</b> ${esc(SHORT_REASON.david)}.<div class="tiny" style="margin-top:2px;color:#d9968c">${esc(c.exclusion.detail)}</div></div></div>`;
  msgs.insertAdjacentHTML('beforeend', v); moveCard(c.id, 'x'); $('#feed').scrollTop = $('#feed').scrollHeight;
  await wait(900);
}

async function investigateSarah(c, wait) {
  addLine(`${esc(c.name)}`, 'head');
  addLine(`Initial match: <b>${c.surface}%</b>`, 'sub');
  await wait(450);
  addLine('Unlocking contextual evidence…', 'dim');
  await unlockSeq(c, wait);
  addLine('Contacting Sarah’s Dub…', 'dim'); await wait(500);
  const msgs = openConvo(c, 'Sarah’s Dub');
  const name = 'Sarah’s Dub';
  for (const it of INTENTS.filter((i) => i.script)) {
    await say(msgs, 'agent', agentMsg(it.ask), wait);
    const rec = E.askDub(S, it.id); persist();
    await say(msgs, 'dub', dubBubble(name, rec, it), wait);
    if (rec.kind === 'unknown') {
      sysNote(msgs, '<b>Clarification requested from Sarah.</b> She permits clarification requests. The agent does not guess.'); await wait(500);
      msgs.insertAdjacentHTML('beforeend', '<div class="typing" id="typ" style="align-self:flex-start;background:rgba(95,211,154,.1)"><i style="background:var(--green)"></i><i style="background:var(--green)"></i><i style="background:var(--green)"></i></div>'); await wait(1300); $('#typ')?.remove();
      msgs.insertAdjacentHTML('beforeend', `<div class="msg human"><small>Sarah</small>Yes. I participated directly in the final negotiation.</div>`); await wait(700);
      E.clarify(S, it.id, 'yes'); persist();
      const upd = S.interview.log.at(-1);
      await say(msgs, 'dub', `<div class="msg dub learned"><small>${name}</small><div><b>Context updated.</b></div><div>${esc(upd.text)}</div><div class="ev"><span class="t">Provenance</span>${prov('self')}<span class="tiny">Added: ${esc(upd.addedAt)}</span></div></div>`, wait, 400);
      await wait(400);
    }
  }
  msgs.insertAdjacentHTML('beforeend', verdictHtml(true, c, `<b>Contextual match: ${c.contextual}%</b><div class="tiny">Led her raise · enterprise SaaS · open to compensated research · $${S.dub.pricing.jam60}/hour</div>`));
  moveCard(c.id, 'q'); $('#feed').scrollTop = $('#feed').scrollHeight; toast('Sarah’s Dub learned something new');
  await wait(900);
}

async function investigateFast(c, wait) {
  const row = addHtml(`<div class="fast"><span class="nm">${esc(c.name)}</span><span class="tiny">Unlocking context · ${usd2(PRICING.contextUnlockUsd)}…</span><span class="res"></span></div>`);
  await wait(380);
  E.unlockContext(S, c.id); persist(); updBudget();
  row.querySelector('.tiny').textContent = `Context unlocked · ${usd2(PRICING.contextUnlockUsd)}`;
  await wait(320);
  const ok = !c.exclusion;
  const res = row.querySelector('.res'); res.className = 'res ' + (ok ? 'q' : 'x');
  res.textContent = ok ? `✓ Qualified · ${c.contextual}%` : `✕ ${SHORT_REASON[c.id] || c.exclusion.reason}`;
  moveCard(c.id, ok ? 'q' : 'x'); $('#feed').scrollTop = $('#feed').scrollHeight;
  await wait(280);
}

VIEWS.understand = VIEWS.discover = VIEWS.investigate = VIEWS.qualify = {
  html: () => workspaceHtml(),
  async start(t, wait) {
    // 2. understand
    S.pool = {}; persist(); setPhase('understand'); live('Understanding');
    addLine('Understanding your request…', 'head');
    for (const c of PARSED_CRITERIA) { await wait(330); addLine(`${esc(c.key)}: <b>${esc(c.value)}</b>`, 'ok'); critLine(c); }
    await wait(450);
    // 3. discover
    setPhase('discover'); live('Searching');
    addLine('Searching the Peeps network…', 'head'); addHtml('<div class="scan"><i id="scanbar" style="width:100%;transition-duration:' + (0.9 * SPEEDS[speed]) + 's"></i></div>');
    await wait(900);
    for (const c of [...CANDIDATES].sort((a, b) => b.surface - a.surface)) { moveCard(c.id, 'queued'); addLine(`Potential candidate · <b>${esc(c.name)}</b> <span class="mut">· ${esc(c.headline)} · ${c.surface}% initial match</span>`, 'dim'); await wait(210); }
    addLine(`${CANDIDATES.length} potential candidates found.`, 'head'); await wait(500);
    addLine('Investigating candidates…', 'sub'); await wait(450);
    // 4–5. investigate + A2A
    setPhase('investigate'); live('Investigating');
    for (const id of INVESTIGATION_ORDER) {
      const c = E.candidate(id); moveCard(id, 'inv'); await wait(250);
      if (id === 'david') await investigateDavid(c, wait);
      else if (id === 'sarah') await investigateSarah(c, wait);
      else await investigateFast(c, wait);
    }
    setPhase('qualify'); live('Qualifying');
    const sum = E.runBatchQualification(S); persist();
    addLine(`Pool processed: <b>${sum.qualified.length} qualified</b> · ${sum.excluded.length} excluded · ${usd2(sum.contextSpend)} of context purchased`, 'head');
    await wait(1700);
    enter('shortlist');
  },
};

// ------------------------------------------------------------------ 6. shortlist (agent returns control)
VIEWS.shortlist = {
  html: () => {
    const sum = E.batchSummary(S); const david = E.candidate('david'); const total = E.introTotal();
    return `<div class="sl-head"><div class="eyebrow">Your agent is back</div><h1 class="h1" style="margin:8px 0 6px">I found 3 people<br><span style="color:var(--accent2)">worth your time.</span></h1></div>
    <div class="grid4" style="margin-bottom:18px"><div class="stat"><small>Investigated</small><b>${sum.investigated}</b></div><div class="stat"><small>Qualified</small><b style="color:var(--green)">${sum.qualified.length}</b></div><div class="stat"><small>Excluded</small><b style="color:var(--red)">${sum.excluded.length}</b></div><div class="stat"><small>Context purchased</small><b>${usd2(sum.contextSpend)}</b></div></div>
    <div class="rec3">${sum.qualified.map((c) => `<article class="card ${c.hero ? 'glow' : ''}"><div class="row">${av(c, 'lg')}<div><b style="font-size:20px">${esc(c.name)}</b><div class="mut" style="font-size:13px">${esc(c.headline)} · ${esc(c.sector)}</div></div></div><div class="row sp"><div><div class="pct">${c.contextual}%</div><div class="tiny">contextual match</div></div><div style="text-align:right"><b style="font-size:20px">${usd(c.rate)} / hour</b></div></div><div class="lbl" style="margin:6px 0 0">Why</div><ul class="rs">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></article>`).join('')}</div>
    <div class="davidcard" style="margin:18px 0"><div><div class="tiny" style="color:#d9968c;letter-spacing:.12em;text-transform:uppercase;font-weight:800">Excluded by your agent</div><div class="row" style="margin-top:6px">${av(david, 'lg')}<div><b style="font-size:22px">${esc(david.name)}</b><div class="mut">${david.surface}% keyword match</div></div></div></div><div class="big2" style="color:var(--red)">✕ EXCLUDED</div><p style="max-width:430px;color:#ffb3a8"><b>71% recent crypto activity</b> conflicted with your request. Strong keyword match, poor contextual match.</p></div>
    <div class="row wrap tiny" style="margin-bottom:18px"><span>Also excluded:</span>${sum.excluded.filter((c) => c.id !== 'david').map((c) => `<span class="chip bad">${esc(c.name.split(' ')[0])} · ${esc(SHORT_REASON[c.id] || c.exclusion.reason)}</span>`).join('')}</div>
    <div class="recommend"><div style="max-width:560px"><div class="eyebrow">Agent recommendation</div><p style="font-size:20px;margin-top:6px">I recommend approaching all three. Their combined Jam cost is <b>${usd(total)}</b>.</p></div><button class="cta xl" data-act="authorize">Authorize introductions · ${usd(total)}</button></div>`;
  },
};

// ------------------------------------------------------------------ 7. approach
VIEWS.approach = {
  html: () => workspaceHtml(),
  async start(t, wait) {
    setPhase('approach'); live('Approaching');
    PARSED_CRITERIA.forEach(critLine);
    addLine(`Introductions authorized · ${usd(E.introTotal())}`, 'head'); await wait(600);
    const q = E.qualifiedCandidates();
    for (const c of q) { if (!S.pool[c.id]) S.pool[c.id] = 'q'; }
    // Sarah: full sequence
    addLine('Contacting Sarah’s Dub…', 'dim'); await wait(500);
    const steps = ['Opportunity presented', 'Sarah’s boundaries satisfied', `Rate confirmed: ${usd(S.dub.pricing.jam60)}`, 'Sarah accepted', 'Permission granted · shares display name, company, contact via Toasty only', null, null];
    for (const [i, s] of steps.entries()) {
      if (s) addLine(s, 'ok');
      if (i === 5) { E.reserveJam(S, 'sarah'); persist(); updIntro(); addLine('Jam created', 'ok'); addLine(`${usd(E.candidate('sarah').rate)} reserved`, 'ok'); $('[data-pid="sarah"]')?.classList.add('booked'); break; }
      await wait(300);
    }
    await wait(300);
    for (const c of q.filter((x) => x.id !== 'sarah')) {
      const row = addHtml(`<div class="fast"><span class="nm">${esc(c.name)}</span><span class="tiny">Contacting ${esc(c.name.split(' ')[0])}’s Dub…</span><span class="res"></span></div>`); await wait(330);
      row.querySelector('.tiny').textContent = `Boundaries satisfied · rate ${usd(c.rate)} confirmed · accepted`; await wait(330);
      E.reserveJam(S, c.id); persist(); updIntro();
      const r = row.querySelector('.res'); r.className = 'res q'; r.textContent = `✓ Jam created · ${usd(c.rate)} reserved`;
      $(`[data-pid="${c.id}"]`)?.classList.add('booked'); $('#feed').scrollTop = $('#feed').scrollHeight; await wait(350);
    }
    addLine(`All three Dubs accepted. ${usd(E.jamReserved(S))} reserved.`, 'head'); live('Done', true); await wait(1300);
    enter('ready');
  },
};

// ------------------------------------------------------------------ 8. ready (human action #3)
VIEWS.ready = {
  html: () => {
    const others = E.qualifiedCandidates().filter((c) => c.id !== 'sarah');
    return `<div class="jamcard card glow stack" style="margin-top:4vh"><div class="status">Sarah accepted</div><h1 class="big">Your agents handled the qualification.<br><span style="color:var(--accent2)">Now it’s worth your time to talk.</span></h1>
    <div class="card" style="background:#150c0a;text-align:left"><div class="row sp wrap"><div class="row">${av({ name: 'Sarah Chen', hue: 22 }, 'lg')}<div><b style="font-size:22px">Sarah Chen</b><div class="mut">Fundraising Research Jam</div></div></div><div class="row wrap"><span class="b plain">60 minutes</span><span class="b verified">${usd(JAM.rate)} committed</span><span class="b plain">Recorded · transcribed · with consent</span></div></div></div>
    <button class="cta xl" data-act="joinjam">Join Jam →</button>
    <p class="tiny">Also reserved by your agent: ${others.map((c) => `${esc(c.name.split(' ')[0])} (${usd(c.rate)})`).join(' · ')}</p></div>`;
  },
};

// ------------------------------------------------------------------ 9. studio
VIEWS.studio = {
  html: () => `<div class="eyebrow">The human layer</div><div class="studio-wrap" style="margin-top:8px"><div class="room"><div class="room-h"><div class="row"><img src="../../shared/brand/toasty-media/ToastyTransparent.png" width="30" alt=""><b>Toasty Studio</b><span class="mut">· ${JAM.title}</span></div><div class="row wrap"><span class="rec" id="recind" style="visibility:hidden">REC</span><span class="b verified" id="trind" style="visibility:hidden">Live transcription</span><span class="tiny" id="clock">00:00 · demo clock</span></div></div>
  <div class="tiles"><div class="tile" style="--h:22" id="tSarah">${av({ name: 'Sarah Chen', hue: 22 }, 'xl')}<span class="nm">Sarah Chen</span><div class="lv"><i></i><i></i><i></i><i></i><i></i></div></div><div class="tile quiet" style="--h:200" id="tReq">${av({ name: 'Ricardo', hue: 200 }, 'xl')}<span class="nm">${esc(REQUESTER.name)} · ${esc(REQUESTER.org)}</span><div class="lv"><i></i><i></i><i></i><i></i><i></i></div></div></div>
  <div class="row sp wrap" style="padding:0 18px 12px"><div class="chips" id="consent"><span class="b plain">Consent</span><span class="b self" id="cS">Sarah · waiting</span><span class="b self" id="cR">${esc(REQUESTER.name)} · waiting</span></div></div>
  <div id="moxie"></div><div class="caps" id="caps"></div>
  <div class="room-f"><span></span><button class="cta" data-act="endjam">End Jam</button></div></div>
  <aside class="card stack"><div class="lbl">Jam context</div><b style="font-size:18px">${JAM.title}</b><div class="row wrap"><span class="b plain">60 min</span><span class="b verified">${usd(JAM.rate)} committed</span></div><div class="hr"></div><div class="lbl">Briefed by your agent</div><p class="mut" style="font-size:14px">Goal: understand founder fundraising experience.</p><div class="lbl">Sarah will discuss</div><div class="chips">${S.dub.interests.topics.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div><div class="lbl">Sarah won’t disclose</div><div class="chips">${S.dub.boundaries.topics.slice(0, 2).map((x) => `<span class="chip bad">${esc(x)}</span>`).join('')}</div></aside></div>`,
  async start(t, wait) {
    await wait(900); $('#cS').textContent = 'Sarah · consented ✓'; $('#cS').className = 'b verified'; await wait(700);
    $('#cR').textContent = `${REQUESTER.name} · consented ✓`; $('#cR').className = 'b verified'; await wait(600);
    $('#recind').style.visibility = 'visible'; $('#trind').style.visibility = 'visible';
    const caps = $('#caps'); caps.innerHTML = ''; let sec = 0;
    const clock = setInterval(() => { sec++; const c = $('#clock'); if (c) c.textContent = `00:${String(sec).padStart(2, '0')} · demo clock`; }, 1000 / SPEEDS[speed]);
    try {
      for (let i = 0; i < TRANSCRIPT.length; i++) {
        const l = TRANSCRIPT[i]; const sarah = l.who === 'Sarah';
        $('#tSarah').classList.toggle('quiet', !sarah); $('#tReq').classList.toggle('quiet', sarah);
        caps.insertAdjacentHTML('beforeend', `<div class="cap ${sarah ? '' : 'r'}"><small>${l.t}</small><b>${esc(l.who)}</b> ${esc(l.text)}</div>`);
        if (i === 1) $('#moxie').innerHTML = `<div class="moxie"><b>Moxie</b> · Suggested question: “What surprised you most about the process?”</div>`;
        await wait(2000);
      }
      await wait(1000);
    } finally { clearInterval(clock); }
    enter('wrapup');
  },
};

// ------------------------------------------------------------------ 10. wrap-up (agent resumes) + results
VIEWS.wrapup = {
  html: () => `<div class="proc"><div class="eyebrow">The Jam has ended</div><h1 class="h1" style="font-size:clamp(30px,4.5vw,52px)">Your agent<br>takes it from here.</h1><div class="ps" id="wps">${['Recording saved', 'Transcript generated', 'Key insights extracted', 'Breadcrumb created', 'Participation verified', `${usd(JAM.rate)} settlement released`, 'Sarah’s Dub updated'].map((s) => `<div>${s}</div>`).join('')}</div></div>`,
  async start(t, wait) {
    for (const el of document.querySelectorAll('#wps div')) { await wait(480); el.classList.add('on'); }
    E.completeJam(S, { actualMin: 1, demoClock: true }); S.post.stage = 0; persist();
    await wait(700); enter('results');
  },
};

const sigHtml = (tr) => tr.signals.map((s) => `<div class="sig"><i class="${s.status}">${s.status === 'pass' ? '✓' : s.status === 'flag' ? '!' : '~'}</i><div><b>${esc(s.label)}</b><div class="tiny">${esc(s.detail)}</div></div></div>`).join('');
VIEWS.results = {
  html: () => {
    const bc = S.dub.breadcrumbs.find((b) => b.id === 'bc_jam_1'); const st = S.post.stage; const tr = S.post.trust;
    const before = E.COVERAGE.base; const after = E.coverage(S);
    const artifacts = `<div class="grid2"><div class="card stack"><div class="row sp"><b>Recording</b><span class="b demoflag plain">Demo clip</span></div><div class="vid"><div class="play">▶</div><div class="wave">${Array.from({ length: 48 }, (_, i) => `<i style="height:${10 + Math.abs(Math.sin(i * 1.7) * 44) + (i % 5) * 2}px"></i>`).join('')}</div></div><div class="tiny">${esc(POST_JAM.durationLabel)}</div></div>
    <div class="card"><div class="row sp"><b>Transcript</b><span class="b demoflag plain">Scripted demo transcript</span></div><div class="tl">${TRANSCRIPT.map((l) => `<div><small>${l.t}</small><b class="${l.who === 'Sarah' ? '' : 'r'}">${esc(l.who)}</b> ${esc(l.text)}</div>`).join('')}</div></div></div>
    <div class="grid3" style="margin-top:16px"><div class="card"><div class="lbl">Summary</div><p class="mut">${esc(POST_JAM.summary)}</p></div><div class="card"><div class="lbl">Key insights</div><ul class="rs">${POST_JAM.insights.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div><div class="card"><div class="lbl">Action items</div><ul class="rs">${POST_JAM.actions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div></div>`;
    return `<div class="eyebrow">Your agent resumed</div><h1 class="h2">The conversation just paid off.</h1>
    <div class="grid2" style="margin-top:14px"><div class="card glow stack"><div class="lbl">Payment · Dough</div><div class="bigmoney" id="dough">+${usd(S.post.held ? 0 : JAM.rate)}</div><div class="row wrap"><span class="b verified">${S.post.held ? 'Held for review' : 'Settled to Sarah’s Dough'}</span><span class="b demoflag plain">Demo transaction · not settled on-chain</span></div><div class="tiny">Sarah’s Dough balance: <b>${usd2(S.sarahDough)}</b> (demo)</div></div>
    <div class="card stack reveal ${st >= 1 ? 'on' : ''}" id="rvBC"><div class="crumb"><div class="lbl" style="color:var(--green)">New verified Breadcrumb</div><h3 style="font-size:22px;margin:6px 0 14px">${esc(bc.text)}</h3><div class="row wrap"><span class="b verified">Verified</span><span class="b plain">${esc(bc.date)}</span><span class="b plain">Evidence: Studio recording + transcript</span><span class="b plain">Payment: ${usd(JAM.rate)}</span></div></div></div></div>
    <div class="card glow reveal ${st >= 2 ? 'on' : ''}" id="rvDub" style="margin-top:16px"><div class="row sp wrap"><div><div class="eyebrow">Richer Dub</div><h2 class="h2" style="margin:4px 0">Your Dub got smarter.</h2></div><div class="ring" style="--p:${st >= 2 ? after : before}" id="pring"><b>${st >= 2 ? after : before}%</b></div></div>
    <div class="row sp tiny" style="margin-top:12px"><span>Context coverage at start of demo: ${before}%</span><span>Now: ${after}%</span></div><div class="bar" style="margin:6px 0 14px"><u style="width:${before}%"></u><i id="cbar" style="width:${st >= 2 ? after : before}%"></i></div>
    <div class="grid2"><div class="card" style="background:#150c0a"><div class="lbl">The agent that asked before</div><div class="tiny">${SARAH_DUB.knowledge.length} claims · ${SARAH_DUB.breadcrumbs.length} Breadcrumbs · 0 completed Jams</div></div><div class="card" style="background:rgba(95,211,154,.06);border-color:rgba(95,211,154,.4)"><div class="lbl" style="color:var(--green)">The next agent that asks</div><div class="tiny" style="color:var(--text)">${S.dub.knowledge.length} claims · ${S.dub.breadcrumbs.length} Breadcrumbs · 1 verified completed Jam</div></div></div>
    <div class="msg dub" style="margin-top:12px;max-width:100%"><small>Next agent: “Has Sarah completed a paid research Jam?”</small><div>Yes. One verified Jam, evidenced by a Studio recording and transcript.</div><div class="ev">${prov('verified')}</div></div>
    </div>
    <h3 style="margin:26px 0 12px;font-size:20px">Session artifacts</h3>${artifacts}
    <div class="card" style="margin-top:16px"><div class="row sp"><b>Trust checks on this payout</b><span class="b ${tr.decision === 'release' ? 'verified' : 'unknown'}">${tr.decision === 'release' ? 'Released' : 'Held'}</span></div>${sigHtml(tr)}</div>
    <div class="row sp wrap" style="margin-top:22px"><span></span><button class="cta lg" data-act="togrowth">See how the network grows →</button></div>`;
  },
  async start(t, wait) {
    if (S.post.stage >= 2) return;
    const d = $('#dough');
    for (let i = 0; i <= 20; i++) { d.textContent = '+$' + Math.round((JAM.rate * i) / 20); await wait(30); }
    await wait(900); S.post.stage = 1; persist(); $('#rvBC').classList.add('on'); renderChrome(); toast('Breadcrumb created · Verified');
    await wait(1800); S.post.stage = 2; persist(); $('#rvDub').classList.add('on'); renderChrome();
    await wait(500); const a = E.coverage(S); $('#cbar').style.width = a + '%'; $('#pring').style.setProperty('--p', a); $('#pring b').textContent = a + '%';
  },
};

// ------------------------------------------------------------------ 11. growth: claim your Dub, then invite your network
const SUGGESTED = [
  { id: 'n1', name: 'Pailin R.', initials: 'PR', hue: 15, headline: 'Founder · Bangkok' },
  { id: 'n2', name: 'Arthit S.', initials: 'AS', hue: 200, headline: 'CTO · Chiang Mai' },
  { id: 'n3', name: 'Joy L.', initials: 'JL', hue: 330, headline: 'Angel investor · Bangkok' },
  { id: 'n4', name: 'Krit M.', initials: 'KM', hue: 95, headline: 'Founder · Phuket' },
  { id: 'n5', name: 'Dao W.', initials: 'DW', hue: 260, headline: 'Operator · Bangkok' },
];
const CLAIM_STEPS = ['Confirming it’s you', 'Creating your account', 'Claiming your Breadcrumb', 'Setting your boundaries', `Setting your Jam rate · ${usd(PRICING.externalOfferUsd)} / hour`, 'Your Dub is live'];
const invited = () => (S.growth.invited = S.growth.invited || []);
const netSvg = () => {
  const live = S.growth.stage >= 4; const inv = invited();
  const base = [['You', 80, 130, 1], ['Sarah', 200, 60, 1], ['Niran', 200, 200, 0.5], [INVITEE.name.split(' ')[0], 340, 130, live ? 1 : 0.25]];
  const spots = [[480, 40], [520, 100], [520, 160], [480, 220], [420, 250]];
  const nodes = base.concat(inv.map((id, i) => [SUGGESTED.find((x) => x.id === id).name.split(' ')[0], spots[i][0], spots[i][1], 0.85]));
  const edges = [[0, 1], [0, 2], [1, 3]].concat(inv.map((_, i) => [3, 4 + i]));
  return `<svg class="net" viewBox="0 0 600 270"><g stroke="var(--line2)" stroke-width="2">${edges.map(([x, y]) => `<line x1="${nodes[x][1]}" y1="${nodes[x][2]}" x2="${nodes[y][1]}" y2="${nodes[y][2]}" ${nodes[y][3] < 1 ? 'stroke-dasharray="5 5"' : 'stroke="var(--accent)"'}/>`).join('')}</g>${nodes.map((n) => `<g opacity="${n[3]}"><circle cx="${n[1]}" cy="${n[2]}" r="26" fill="var(--card2)" stroke="${n[3] === 1 ? 'var(--accent)' : 'var(--line2)'}" stroke-width="2"/><text x="${n[1]}" y="${n[2] + 4}" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="800">${esc(n[0])}</text></g>`).join('')}</svg>`;
};
function growthBody() {
  const g = S.growth.stage;
  if (g === 0) return `<div class="msgcard stack"><div class="tiny">TOASTY PEEPS · on behalf of a requester · text / email</div><p><b>Someone is looking for expertise like yours and is willing to pay ${usd(PRICING.externalOfferUsd)} for a one-hour conversation.</b></p><p class="mut">Interested? No account needed to take part.</p><div class="row"><span class="live">${esc(INVITEE.name)} is replying…</span></div></div>`;
  if (g === 1) return `<div class="msgcard stack"><span class="b verified">Invite accepted</span><h3 style="font-size:22px">Joined with a link. No sign-up.</h3><div class="row"><span class="live">Jam in progress…</span></div></div>`;
  if (g === 2) return `<div class="msgcard stack" style="max-width:560px"><div class="eyebrow">Thank you for taking part</div><h3 style="font-size:28px;line-height:1.1">You contributed to this Jam.<br>Claim your Dub.</h3><p class="mut">Your conversation is now evidence. Claim it and it works for you.</p><ul class="rs"><li>Claim your Breadcrumb and your ${usd(PRICING.externalOfferUsd)}</li><li>Control how agents represent you</li><li>Set your boundaries and your Jam rate</li><li>Get matched to future paid opportunities</li></ul><button class="cta lg" data-act="claim">Claim my Dub →</button></div>`;
  if (g === 3) return `<div class="msgcard stack" style="max-width:520px"><div class="eyebrow">Creating your account</div><div class="ps" id="cps" style="margin-top:6px">${CLAIM_STEPS.map((x) => `<div>${esc(x)}</div>`).join('')}</div></div>`;
  const d = S.growth.claimedDub; if (!d) return '';
  return `<div class="msgcard stack" style="max-width:520px;border-color:rgba(95,211,154,.45)"><div class="row">${av(INVITEE, 'lg')}<div><b style="font-size:20px">${esc(d.owner)}’s Dub</b><div class="mut">${esc(d.headline)}</div></div></div><div class="crumb"><div class="lbl" style="color:var(--green)">First Breadcrumb</div><b>${esc(d.breadcrumbs[0].text)}</b><div class="row wrap" style="margin-top:8px"><span class="b verified">Verified</span><span class="b plain">${esc(d.breadcrumbs[0].date)}</span></div></div><div class="row wrap"><span class="b self plain">${usd(d.pendingDoughUsd)} ready to claim</span><span class="b plain">${usd(PRICING.externalOfferUsd)} / hour</span></div></div>`;
}
function inviteHtml() {
  const inv = invited();
  return `<div class="lbl" style="margin-top:14px">Invite people in your network who might be interested</div><div class="stack">${SUGGESTED.map((x) => `<div class="src"><div class="row">${av(x)}<div><b>${esc(x.name)}</b><div class="tiny">${esc(x.headline)}</div></div></div>${inv.includes(x.id) ? '<span class="b verified">Invited</span>' : `<button class="ghost" data-act="invite" data-id="${x.id}">Invite</button>`}</div>`).join('')}</div>`;
}
const growthRefresh = () => { $('#gbody').innerHTML = growthBody(); $('#net').innerHTML = netSvg(); const iv = $('#invites'); if (iv) { iv.hidden = S.growth.stage < 4; iv.innerHTML = S.growth.stage >= 4 ? inviteHtml() : ''; } renderChrome(); };
async function runClaim(t, wait) {
  for (const el of document.querySelectorAll('#cps div')) { await wait(520); el.classList.add('on'); }
  E.claimDub(S); S.growth.stage = 4; persist(); await wait(500); growthRefresh(); toast('Your Dub is live · first Breadcrumb claimed');
}
VIEWS.growth = {
  html: () => `<div class="eyebrow">Network growth</div><h1 class="h2">Every Jam can create a new Dub.</h1>
  <div class="grid2" style="margin-top:12px"><div class="card stack glow"><div class="lbl">${esc(INVITEE.name)} · not a Peep yet</div><div id="gbody">${growthBody()}</div></div>
  <div class="card"><div class="lbl">Your network</div><div id="net">${netSvg()}</div><div id="invites" ${S.growth.stage >= 4 ? '' : 'hidden'}>${S.growth.stage >= 4 ? inviteHtml() : ''}</div></div></div>
  <div class="card stack" style="margin-top:16px"><div class="lbl">Cold start · not enough internal matches</div><div class="row wrap"><span class="b verified">1 verified Peeps match</span><span class="b self">2 potential external matches</span></div>
  <div class="grid2">${EXTERNAL_MATCHES.map((m) => `<div class="src"><div class="row">${av(m)}<div><b>${esc(m.name)}</b> <span class="b plain">Not a Peep yet</span><div class="tiny">${esc(m.headline)} · ${esc(m.note)}</div></div></div></div>`).join('')}</div></div>
  <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="ghost" data-act="reset">Reset the demo ↺</button></div>`,
  async start(t, wait) {
    if (S.growth.stage === 0) { await wait(2600); S.growth.stage = 1; persist(); growthRefresh(); }
    if (S.growth.stage === 1) { await wait(2400); S.growth.stage = 2; persist(); growthRefresh(); }
    if (S.growth.stage === 3) { await runClaim(t, wait); }
  },
};

// ------------------------------------------------------------------ drawers
const SOURCES = [
  ['Provenance + access engine, Dub answers', 'real', 'Runs real logic over the seeded evidence: answers only from claims, says Unknown, withholds Private, turns a clarification into persistent context.'],
  ['Agent investigation loop & budget', 'real', 'Real orchestration code. Order, pacing and outcomes are deterministic and seeded.'],
  ['Trust / payout-hold evaluator', 'real', 'Real decision logic. Session inputs are seeded; see Trust.'],
  ['Ledger arithmetic', 'real', 'Real math. Every entry is flagged demo with settlement: none.'],
  ['Dub profiles, evidence, Breadcrumbs', 'seed', 'Seeded. Stored only in this browser (localStorage key toasty.peeps.demo.v1).'],
  ['Candidate pool & external matches', 'seed', 'Seeded, fictional people. No network search runs.'],
  ['Sarah’s clarification reply', 'seed', 'Seeded: Sarah’s answer is auto-simulated after a short delay.'],
  ['Outcome interpretation', 'mock', 'Deterministic interpreter standing in for the LLM. Same output every run.'],
  ['Context unlock · x402 / Solana', 'mock', 'Mocked: demo ledger entries only. No RPC call, no wallet, no on-chain settlement.'],
  ['Dough balance & Jam escrow', 'mock', 'Demo ledger. Does not touch real Dough accounts.'],
  ['Toasty Studio room', 'mock', 'Simulated Studio session. The real Studio at /studio is untouched and not called.'],
  ['Recording & transcript', 'mock', 'Scripted demo clip and transcript; no media is captured.'],
];
function dubDrawer() {
  const p = S.dub.profile; const cov = E.coverage(S);
  return `<h2 class="h2">Sarah’s Dub</h2><p class="mut" style="margin-bottom:14px">What your agent is talking to: permissioned, evidence-backed, protective of its human.</p><div class="row wrap" style="margin-bottom:6px"><div class="ring" style="--p:${cov};width:84px;height:84px"><b style="font-size:20px">${cov}%</b></div><div><b>${esc(p.name)}</b> · ${esc(p.role)}<div class="mut" style="font-size:13px">${esc(p.headline)}</div><div class="tiny">${S.dub.knowledge.length} claims · ${S.dub.breadcrumbs.length} Breadcrumbs · context coverage, not a person score</div></div></div><div class="tabs">${TABS.map(([id, l]) => `<button class="tab ${dubTab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">${l}</button>`).join('')}</div><div class="card" id="dubPane">${dubPane()}</div>`;
}
function drawer(pane) {
  const d = $('#drawer'); d.hidden = false; d.className = 'drawer' + (pane === 'dub' ? ' wide' : '');
  let body = '';
  if (pane === 'dub') body = dubDrawer();
  if (pane === 'sources') body = `<h2 class="h2">Data sources</h2><p class="mut" style="margin-bottom:14px">What is real, what is seeded, what is a mocked fallback.</p>${SOURCES.map(([n, m, t]) => `<div class="src" style="margin-bottom:8px;align-items:flex-start"><div><b>${n}</b><div class="tiny">${t}</div></div><span class="mode ${m}">${{ real: 'REAL LOGIC', seed: 'SEEDED', mock: 'MOCKED' }[m]}</span></div>`).join('')}`;
  if (pane === 'ledger') body = `<h2 class="h2">Demo ledger</h2><p class="mut" style="margin-bottom:14px">Every transaction below is a <b>demo transaction</b>. Nothing settles on-chain.</p>${S.ledger.length ? S.ledger.map((e) => `<div class="src" style="margin-bottom:8px"><div><b>${esc(e.label)}</b><div class="tiny">${esc(e.id)} · ${esc(e.from)} → ${esc(e.to)}</div></div><div style="text-align:right"><b>${usd2(e.amountUsd)}</b><div><span class="mode seed">DEMO</span></div></div></div>`).join('') : '<p class="mut">No transactions yet.</p>'}<div class="hr"></div><div class="row sp"><b>Context purchased</b><b>${usd2(E.contextSpend(S))}</b></div><div class="row sp"><b>Jams reserved</b><b>${usd2(E.jamReserved(S))}</b></div><div class="row sp"><b>Sarah’s Dough (demo)</b><b>${usd2(S.sarahDough)}</b></div>`;
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
let joining = false;
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  switch (a) {
    case 'find': { // human action #1
      S = E.initialState(); S.request = { text: REQUEST_TEXT }; enter('understand'); return; // canonical seeded request only
    }
    case 'authorize': return enter('approach'); // human action #2
    case 'joinjam': { // human action #3
      if (joining) return; joining = true;
      try { await interlude('Agents have finished the machine work.', 'Now the humans meet.'); } finally { joining = false; }
      return enter('studio');
    }
    case 'endjam': return enter('wrapup');
    case 'togrowth': return enter('growth');
    case 'claim': { S.growth.stage = 3; persist(); growthRefresh(); const t = token; guarded(() => runClaim(t, mkWait(t))); return; }
    case 'invite': { const inv = invited(); if (!inv.includes(el.dataset.id)) inv.push(el.dataset.id); persist(); growthRefresh(); return; }
    case 'reset': S = E.resetState(localStorage); $('#drawer').hidden = true; $('#overlay').hidden = true; joining = false; render(); window.scrollTo({ top: 0 }); return;
    case 'speed': speed = el.dataset.v; try { localStorage.setItem(SPEED_KEY, speed); } catch { /* noop */ } renderChrome(); return;
    case 'drawer': return drawer(el.dataset.pane);
    case 'closedrawer': $('#drawer').hidden = true; return;
    case 'scn': trustScn = el.dataset.k; return drawer('trust');
    case 'tab': dubTab = el.dataset.tab; document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === dubTab)); $('#dubPane').innerHTML = dubPane(); return;
    case 'chipdel': { get(S.dub, el.dataset.path).splice(+el.dataset.i, 1); persist(); $('#dubPane').innerHTML = dubPane(); return; }
    case 'toggle': set(S.dub, el.dataset.path, !get(S.dub, el.dataset.path)); persist(); $('#dubPane').innerHTML = dubPane(); return;
  }
});
document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-bind]'); if (!el) return;
  set(S.dub, el.dataset.bind, el.type === 'number' ? Number(el.value || 0) : el.value); persist();
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-act="access"]'); if (!el) return;
  S.dub.knowledge.find((x) => x.id === el.dataset.id).access = el.value; persist(); $('#dubPane').innerHTML = dubPane();
});
document.addEventListener('keydown', (ev) => {
  const el = ev.target.closest?.('[data-chipadd]');
  if (el && ev.key === 'Enter' && el.value.trim()) { get(S.dub, el.dataset.chipadd).push(el.value.trim()); persist(); $('#dubPane').innerHTML = dubPane(); $(`[data-chipadd="${el.dataset.chipadd}"]`)?.focus(); }
});

// A page reload mid-run restarts that autonomous phase deterministically.
if (['understand', 'discover', 'investigate', 'qualify'].includes(S.phase)) { S = E.initialState(); S.request = { text: REQUEST_TEXT }; S.phase = 'understand'; }
render();
