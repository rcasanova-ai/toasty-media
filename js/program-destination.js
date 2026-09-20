// One Program → many destinations. Adapters implement start/stop/send.
// No vendor streaming APIs are implemented in this slice.

export const ProgramDestinationKind = Object.freeze({
  TOASTY_AUDIENCE: "toasty-audience",
  YOUTUBE: "youtube",
  X: "x",
  LINKEDIN: "linkedin",
  TELEGRAM: "telegram",
  RTMP: "rtmp",
  CUSTOM: "custom"
});

export const ProgramDestinationStatus = Object.freeze({
  IDLE: "idle",
  ARMED: "armed",
  LIVE: "live",
  FAILED: "failed"
});

export function createProgramDestination({
  id,
  kind,
  label = "",
  enabled = false,
  status = ProgramDestinationStatus.IDLE,
  reason = "not-implemented"
} = {}) {
  const destKind = Object.values(ProgramDestinationKind).includes(kind) ? kind : ProgramDestinationKind.CUSTOM;
  return {
    id: id || destKind,
    kind: destKind,
    label: label || destKind,
    enabled: Boolean(enabled),
    status,
    reason
  };
}

export class ProgramDestinationRouter {
  constructor(destinations = []) {
    this.destinations = new Map();
    const initial = destinations.length ? destinations : [
      createProgramDestination({ kind: ProgramDestinationKind.TOASTY_AUDIENCE, label: "Toasty Audience", enabled: true, status: ProgramDestinationStatus.ARMED, reason: "program-output" })
    ];
    initial.forEach((item) => this.destinations.set(item.id, item));
  }

  list() {
    return [...this.destinations.values()];
  }

  arm(id) {
    const dest = this.destinations.get(id);
    if (!dest) return { ok: false, reason: "unknown-destination" };
    dest.status = ProgramDestinationStatus.ARMED;
    return { ok: true, destination: dest };
  }

  // Live push is not implemented for third-party destinations in this construction pass.
  goLive(id) {
    const dest = this.destinations.get(id);
    if (!dest) return { ok: false, reason: "unknown-destination" };
    if (dest.kind === ProgramDestinationKind.TOASTY_AUDIENCE) {
      dest.status = ProgramDestinationStatus.LIVE;
      dest.reason = "program-output";
      return { ok: true, destination: dest };
    }
    dest.status = ProgramDestinationStatus.FAILED;
    dest.reason = "destination-adapter-not-implemented";
    return { ok: false, reason: dest.reason, destination: dest };
  }
}
