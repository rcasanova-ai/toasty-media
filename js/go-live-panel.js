// GoLivePanel: the destination chooser behind GO LIVE (Studio and Creator share it).
//
// Normal users see four destinations, each Not connected / Connected / Connecting / Live / Error. First time:
// Connect → paste the destination's RTMPS URL + stream key → Save (stored server-side, encrypted; the key is
// never shown again and never touches localStorage). After that: toggle it ON and press GO LIVE.
// No service URLs, FFmpeg, bitrate or resolution controls appear here.
import { DESTINATION_CATALOG } from "./broadcast-client.js";

const HELP = {
  x: "In X Producer (studio.x.com), create a broadcast source and copy its Stream URL (RTMPS) and Stream key.",
  youtube: "In YouTube Studio → Go live → Stream, copy the Stream URL and Stream key.",
  tiktok: "In TikTok LIVE Studio (or Live Producer), copy the Server URL and Stream key.",
  instagram: "In Instagram Live Producer, copy the Server URL and Stream key."
};
const STATE_LABEL = { idle: "", connecting: "Connecting…", live: "Live", error: "Error", stopped: "" };
const SELECTED_KEY = "toasty.golive.selected"; // destination NAMES only — never URLs or keys

function readSelected() {
  try { return JSON.parse(localStorage.getItem(SELECTED_KEY) || "[]").filter((id) => DESTINATION_CATALOG.some((d) => d.id === id)); } catch (_) { return []; }
}
function writeSelected(ids) { try { localStorage.setItem(SELECTED_KEY, JSON.stringify(ids)); } catch (_) {} }

export class GoLivePanel {
  constructor({ client, studio, onRequestStart, root = document.body }) {
    this.client = client;
    this.studio = studio;
    this.onRequestStart = onRequestStart || (() => studio.goLive(this.selected()));
    this.root = root;
    this.connected = new Map();
    this.selectedIds = new Set(readSelected());
    this.editing = null;
    this.error = "";
    this.saving = false;
    this.lastSnapshot = studio.snapshot();
    this.mount();
    studio.on((snapshot) => {
      const wasLive = this.lastSnapshot.mode === "live";
      this.lastSnapshot = snapshot;
      // Once Program is actually reaching a destination, get out of the way — the status bar takes over.
      if (snapshot.mode === "live" && !wasLive) this.close();
      if (!this.dialog.hidden) this.render();
    });
  }

  selected() { return DESTINATION_CATALOG.map((d) => d.id).filter((id) => this.selectedIds.has(id) && this.connected.has(id)); }

  mount() {
    const dialog = document.createElement("div");
    dialog.className = "golive-dialog";
    dialog.id = "goLiveDialog";
    dialog.hidden = true;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "goLiveTitle");
    dialog.innerHTML = `
      <div class="golive-card">
        <div class="golive-head">
          <div><h2 id="goLiveTitle">Go Live</h2><p class="golive-sub">Choose where to broadcast. Toasty records the show automatically.</p></div>
          <button type="button" class="golive-close" id="goLiveClose" aria-label="Close">×</button>
        </div>
        <ul class="golive-list" id="goLiveList"></ul>
        <p class="golive-error" id="goLiveError" role="alert" hidden></p>
        <p class="golive-hint" id="goLiveHint" hidden></p>
        <div class="golive-actions">
          <button type="button" class="golive-go" id="goLiveGo">Go Live</button>
          <button type="button" class="golive-end" id="goLiveEnd" hidden>End Live</button>
        </div>
      </div>`;
    this.root.appendChild(dialog);
    this.dialog = dialog;
    this.list = dialog.querySelector("#goLiveList");
    this.errorEl = dialog.querySelector("#goLiveError");
    this.hintEl = dialog.querySelector("#goLiveHint");
    this.goBtn = dialog.querySelector("#goLiveGo");
    this.endBtn = dialog.querySelector("#goLiveEnd");
    dialog.querySelector("#goLiveClose").addEventListener("click", () => this.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) this.close(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !dialog.hidden) this.close(); });
    this.goBtn.addEventListener("click", () => this.start());
    this.endBtn.addEventListener("click", () => this.end());
    this.list.addEventListener("click", (event) => this.onListClick(event));
    this.list.addEventListener("change", (event) => {
      const box = event.target.closest("input[data-toggle]");
      if (!box) return;
      if (box.checked) this.selectedIds.add(box.dataset.toggle); else this.selectedIds.delete(box.dataset.toggle);
      writeSelected([...this.selectedIds]);
      this.render();
    });
    this.list.addEventListener("submit", (event) => { event.preventDefault(); this.save(event.target.dataset.dest, event.target); });
  }

  async open() {
    this.dialog.hidden = false;
    this.error = "";
    this.render();
    await this.refresh();
    this.dialog.querySelector("button:not([disabled]), input:not([disabled])")?.focus();
  }

  close() { this.dialog.hidden = true; this.editing = null; }

  async refresh() {
    try {
      const list = await this.client.listDestinations();
      this.connected = new Map(list.map((d) => [d.destination, d]));
      this.error = "";
    } catch (error) {
      this.error = /sign in/i.test(error.message) ? "Sign in to Toasty Studio to connect destinations." : error.message;
    }
    this.render();
  }

  onListClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const dest = button.dataset.dest;
    if (button.dataset.action === "connect" || button.dataset.action === "edit") { this.editing = dest; this.error = ""; this.render(); this.list.querySelector(`form[data-dest="${dest}"] input`)?.focus(); }
    if (button.dataset.action === "cancel") { this.editing = null; this.render(); }
    if (button.dataset.action === "disconnect") this.disconnect(dest);
  }

  async save(dest, form) {
    const streamUrl = form.elements.streamUrl.value.trim();
    const streamKey = form.elements.streamKey.value.trim();
    this.saving = true; this.error = ""; this.render();
    try {
      await this.client.saveDestination({ destination: dest, streamUrl, streamKey });
      form.elements.streamKey.value = ""; // the key has left the browser; it is never kept or shown again
      this.editing = null;
      this.selectedIds.add(dest); writeSelected([...this.selectedIds]);
      await this.refresh();
    } catch (error) {
      this.error = error.message;
    } finally {
      this.saving = false;
      this.render();
    }
  }

  async disconnect(dest) {
    try { await this.client.removeDestination(dest); this.selectedIds.delete(dest); writeSelected([...this.selectedIds]); await this.refresh(); }
    catch (error) { this.error = error.message; this.render(); }
  }

  async start() {
    const chosen = this.selected();
    if (!chosen.length) { this.error = "Turn on at least one connected destination."; this.render(); return; }
    this.error = "";
    try {
      // Called synchronously from the click so the browser's capture picker still has its user gesture.
      await this.onRequestStart(chosen);
      this.render();
    } catch (error) {
      this.error = friendly(error);
      this.render();
    }
  }

  async end() {
    this.endBtn.disabled = true;
    try { await this.studio.endLive(); } finally { this.endBtn.disabled = false; this.render(); }
  }

  render() {
    const snap = this.lastSnapshot;
    const states = new Map(snap.destinations.map((d) => [d.destination, d]));
    const busy = Boolean(snap.busy);
    const liveNow = snap.destinations.length > 0;
    // Keep the form the producer is typing into (and what they typed) across re-renders — a failed save must
    // not wipe the URL/key fields.
    const typing = this.list.querySelector("form");
    this.list.replaceChildren(...DESTINATION_CATALOG.map((dest) => this.row(dest, states.get(dest.id), liveNow, busy)));
    const fresh = this.list.querySelector("form");
    if (typing && fresh && typing.dataset.dest === fresh.dataset.dest) {
      fresh.replaceWith(typing);
      const save = typing.querySelector(".golive-save");
      save.disabled = this.saving;
      save.textContent = this.saving ? "Saving…" : "Save";
    }
    this.errorEl.hidden = !this.error;
    this.errorEl.textContent = this.error;
    const connecting = snap.busy === "going-live" || snap.destinations.some((d) => d.state === "connecting");
    this.hintEl.hidden = !(connecting || snap.recordingError || snap.notice);
    this.hintEl.textContent = snap.recordingError || (connecting
      ? "Select the Toasty Program Output tab and turn Share tab audio ON, then click Share. You only pick once."
      : snap.notice);
    this.goBtn.hidden = liveNow;
    this.goBtn.disabled = busy || !this.selected().length;
    this.goBtn.textContent = busy ? "Connecting…" : "Go Live";
    this.endBtn.hidden = !liveNow;
  }

  row(dest, live, liveNow, busy) {
    const li = document.createElement("li");
    const connection = this.connected.get(dest.id);
    li.className = "golive-row";
    li.dataset.dest = dest.id;
    const state = live?.state || (connection ? "connected" : "not-connected");
    li.dataset.state = state;
    const label = live && STATE_LABEL[live.state] ? STATE_LABEL[live.state] : connection ? "Connected" : "Not connected";
    const head = document.createElement("div");
    head.className = "golive-row-head";
    if (connection && !liveNow) {
      const toggle = document.createElement("label");
      toggle.className = "golive-toggle";
      toggle.innerHTML = `<input type="checkbox" data-toggle="${dest.id}" ${this.selectedIds.has(dest.id) ? "checked" : ""} ${busy ? "disabled" : ""}><span class="golive-switch" aria-hidden="true"></span><span class="golive-name">${dest.label}</span>`;
      head.append(toggle);
    } else {
      const name = document.createElement("span");
      name.className = "golive-name";
      name.textContent = dest.label;
      head.append(name);
    }
    const chip = document.createElement("span");
    chip.className = "golive-chip";
    chip.dataset.state = state;
    chip.textContent = (live?.state === "live" ? "● " : "") + label;
    head.append(chip);
    li.append(head);
    if (live?.state === "error" && live.error) {
      const err = document.createElement("p");
      err.className = "golive-row-error";
      err.textContent = live.error;
      li.append(err);
    }
    if (!liveNow) {
      const actions = document.createElement("div");
      actions.className = "golive-row-actions";
      if (!connection) actions.innerHTML = `<button type="button" class="golive-link" data-action="connect" data-dest="${dest.id}">Connect ${dest.label}</button>`;
      else actions.innerHTML = `<span class="golive-meta">${escapeHtml(connection.urlHost)} · key ••••${escapeHtml(connection.keyLast4)}</span><button type="button" class="golive-link" data-action="edit" data-dest="${dest.id}">Replace</button><button type="button" class="golive-link" data-action="disconnect" data-dest="${dest.id}">Disconnect</button>`;
      li.append(actions);
      if (this.editing === dest.id) li.append(this.form(dest));
    }
    return li;
  }

  form(dest) {
    const form = document.createElement("form");
    form.className = "golive-form";
    form.dataset.dest = dest.id;
    form.innerHTML = `
      <p class="golive-help">${HELP[dest.id] || ""}</p>
      <label>RTMPS URL<input name="streamUrl" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="rtmps://…" required></label>
      <label>Stream key<input name="streamKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste stream key" required></label>
      <div class="golive-form-actions"><button type="submit" class="golive-save" ${this.saving ? "disabled" : ""}>${this.saving ? "Saving…" : "Save"}</button><button type="button" class="golive-link" data-action="cancel" data-dest="${dest.id}">Cancel</button></div>
      <p class="golive-secure">Saved encrypted on Toasty's server. It's never shown again.</p>`;
    return form;
  }
}

function friendly(error) {
  if (error?.userMessage) return error.userMessage;
  if (error?.reason === "missing-audio" || error?.reason === "audio-not-live") return "Going live needs Program audio. Select the Toasty Program Output tab and turn Share tab audio ON.";
  if (error?.name === "NotAllowedError") return "Sharing the Program Output tab was cancelled. Click Go Live again and select that tab.";
  return String(error?.message || "Could not go live.");
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
