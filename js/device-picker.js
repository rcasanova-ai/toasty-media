// Shared camera/microphone enumeration + preview helpers — extracted verbatim from js/guest.js's
// original implementation (this repair pass) so the Host prejoin (js/host-prejoin.js) gets the exact same
// device-selection behavior a guest already has, instead of a second hand-written copy that could quietly
// drift out of sync: front-camera preference, Camo-camera avoidance, and the loosened-constraint retry
// all matter just as much for a Mac host as for a phone guest.

export async function getUserMediaWithFallback(constraints) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    // Some browsers reject a specific deviceId/facingMode constraint outright (stale device list, camera
    // in use by another app permission flow, etc). Retry with the loosest possible request so the caller
    // still gets a preview and a populated, permission-unlocked device list instead of a black box and
    // empty dropdowns.
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
}

export function deviceConstraint(deviceId, kind) {
  if (deviceId) return { deviceId: { exact: deviceId } };
  // Before device enumeration has populated the dropdown, there's no deviceId yet — for video, ask for
  // the front/selfie camera explicitly (facingMode is video-only, meaningless for audio) rather than
  // leaving it to the browser's own default, which on many phones/webcams is the rear or a virtual camera.
  return kind === "video" ? { facingMode: "user" } : true;
}

export function isCamoCamera(label = "") {
  return /camo/i.test(label);
}

export function preferredCamera(devices) {
  return (
    // Phones report a "facing front"/"user"-style label — prefer the selfie camera, since a rear-facing
    // default (common browser behavior) points at whatever the device is resting against.
    devices.find((device) => /front|user[- ]?facing/i.test(device.label)) ||
    devices.find((device) => /facetime|studio display|built-?in|integrated/i.test(device.label)) ||
    devices.find((device) => !isCamoCamera(device.label) && !/back|rear|environment/i.test(device.label)) ||
    devices.find((device) => !isCamoCamera(device.label)) ||
    devices[0]
  );
}

// Always the RAW device label (what 511a6cd's device-identity fix matches against inside VDO.Ninja's
// iframe) regardless of what's actually being displayed to the user — see fillSelect's dataset.rawLabel.
// Every call site that feeds videoDeviceLabel/audioDeviceLabel to VideoEngine must go through this, never
// read .textContent directly, or a friendly display name would silently get sent to VDO as if it were the
// real device identifier and break the camera matching this same label is used for.
export function selectedDeviceLabel(select) {
  const option = select.selectedOptions[0];
  return option?.dataset.rawLabel || option?.textContent || "";
}

// displayLabel(rawLabel, index): optional — when given, the OPTION'S VISIBLE TEXT becomes
// displayLabel's return value while option.dataset.rawLabel still carries the true raw label
// untouched. Used for mobile-friendly camera names (see friendlyCameraDisplayLabel below) without ever
// touching the identifier VDO.Ninja itself matches against.
export function fillSelect(select, devices, fallbackLabel, displayLabel) {
  const selected = select.value;
  const preferredDeviceId = fallbackLabel === "Camera" ? preferredCamera(devices)?.deviceId : "";
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      const rawLabel = device.label || `${fallbackLabel} ${index + 1}`;
      option.textContent = displayLabel ? displayLabel(rawLabel, index) : rawLabel;
      option.dataset.rawLabel = rawLabel;
      return option;
    })
  );
  if (devices.some((device) => device.deviceId === selected)) {
    select.value = selected;
  } else if (preferredDeviceId) {
    select.value = preferredDeviceId;
  }
}

// "user" (front/selfie) or "environment" (back/rear) per the raw label, or null when neither is
// detectable — the ONE facing heuristic every caller shares (friendly camera names below, and
// js/guest.js's Flip Camera, which keeps an explicit selectedFacing state and refuses to infer a target
// from array position). A single shared function means both can never silently disagree about which
// physical camera "front" means.
export function classifyCameraFacing(rawLabel = "") {
  if (/front|user[- ]?facing/i.test(rawLabel)) return "user";
  if (/back|rear|environment/i.test(rawLabel)) return "environment";
  return null;
}

// DISPLAY ONLY. Real camera labels are raw driver/hardware strings ("camera2 1, facing front") that mean
// nothing to a guest joining from their phone — never shown to a mobile guest; desktop keeps its real
// labels (see js/host-prejoin.js, which never passes friendlyCameraLabels) since multiple real/virtual
// cameras there ARE meaningfully distinguished by name. Positional fallback (not the raw label) when
// front/back can't be detected from the string, so no raw hardware label ever reaches mobile UI.
function friendlyCameraDisplayLabel(rawLabel, index) {
  const facing = classifyCameraFacing(rawLabel);
  if (facing === "user") return "Front Camera";
  if (facing === "environment") return "Back Camera";
  return `Camera ${index + 1}`;
}

export async function hydrateDevices(microphoneSelect, cameraSelect, { friendlyCameraLabels = false } = {}) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(microphoneSelect, devices.filter((device) => device.kind === "audioinput"), "Microphone");
  fillSelect(
    cameraSelect,
    devices.filter((device) => device.kind === "videoinput"),
    "Camera",
    friendlyCameraLabels ? friendlyCameraDisplayLabel : undefined
  );
}

// Full startPreview lifecycle (get media -> hydrate labels now that permission is granted -> restart if
// hydration picked a better default -> swap out an OBS/Camo virtual camera for a real one) as one call,
// since guest.js and host-prejoin.js both need the exact same sequence, not just the individual pieces.
export async function startDevicePreview({ videoEl, cameraSelect, microphoneSelect, previousStream, friendlyCameraLabels = false }) {
  previousStream?.getTracks().forEach((track) => track.stop());
  const cameraBeforeHydration = cameraSelect.value;
  let stream = await getUserMediaWithFallback({
    video: deviceConstraint(cameraSelect.value, "video"),
    audio: deviceConstraint(microphoneSelect.value, "audio")
  });
  videoEl.srcObject = stream;
  await hydrateDevices(microphoneSelect, cameraSelect, { friendlyCameraLabels });

  if (cameraSelect.value && cameraSelect.value !== cameraBeforeHydration) {
    stream.getTracks().forEach((track) => track.stop());
    stream = await getUserMediaWithFallback({
      video: deviceConstraint(cameraSelect.value, "video"),
      audio: deviceConstraint(microphoneSelect.value, "audio")
    });
    videoEl.srcObject = stream;
  } else {
    const selectedCamera = selectedDeviceLabel(cameraSelect);
    if (selectedCamera && isCamoCamera(selectedCamera)) {
      const betterCamera = [...cameraSelect.options].find((option) => !isCamoCamera(option.dataset.rawLabel || option.textContent));
      if (betterCamera) {
        cameraSelect.value = betterCamera.value;
        stream.getTracks().forEach((track) => track.stop());
        stream = await getUserMediaWithFallback({
          video: deviceConstraint(cameraSelect.value, "video"),
          audio: deviceConstraint(microphoneSelect.value, "audio")
        });
        videoEl.srcObject = stream;
      }
    }
  }
  return stream;
}
