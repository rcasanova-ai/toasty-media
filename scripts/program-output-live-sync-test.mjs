#!/usr/bin/env node
// Minimal live-subscriber regression for Program Output.
// It proves the already-open listener reacts to ProgramSync's storage-backed
// state channel without needing a page refresh when BroadcastChannel is absent.

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const listeners = new Map();
const storage = new Map();

global.window = {
  addEventListener(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  },
  removeEventListener(type, callback) {
    listeners.get(type)?.delete(callback);
  }
};

global.localStorage = {
  setItem(key, value) {
    storage.set(key, value);
  },
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  }
};

function dispatchStorage(key, payload) {
  const newValue = JSON.stringify(payload);
  storage.set(key, newValue);
  for (const callback of listeners.get("storage") || []) {
    callback({ key, newValue });
  }
}

const { ProgramSync } = await import("../js/program-sync.js");

console.log("Program Output live sync - storage subscriber fallback");

const roomId = "tm-live-sync";
const sync = new ProgramSync(roomId);
const seen = [];
sync.onMessage((message) => seen.push(message));

const state = {
  roomId,
  scene: "live",
  live: true,
  ticker: { enabled: true, text: "HELLO LIVE OUTPUT", speed: 12 },
  participants: [
    {
      participantId: "host",
      role: "host",
      displayName: "Ricardo Casanova",
      title: "Founder",
      company: "Toasty Peeps",
      transportSourceId: `${roomId}h`,
      connectionStatus: "connected",
      onProgram: true
    }
  ]
};

dispatchStorage(sync.storageKey, state);

assertEqual(seen.length, 1, "already-open Program Output receives storage state");
assertEqual(seen[0].type, "state", "storage event is delivered as canonical state");
assertEqual(seen[0].payload.scene, "live", "scene transition arrives without refresh");
assertEqual(seen[0].payload.ticker.text, "HELLO LIVE OUTPUT", "ticker text arrives without refresh");
assertEqual(seen[0].payload.participants[0].transportSourceId, `${roomId}h`, "participant source arrives without refresh");

dispatchStorage(sync.storageKey, { ...state, scene: "brb", ticker: { enabled: false, text: "", speed: 12 } });

assertEqual(seen.length, 2, "subsequent Program Output state update arrives");
assertEqual(seen[1].payload.scene, "brb", "BRB transition arrives without refresh");
assertEqual(seen[1].payload.ticker.enabled, false, "ticker hide arrives without refresh");

sync.close();

console.log("\nAll Program Output live sync tests passed.");
