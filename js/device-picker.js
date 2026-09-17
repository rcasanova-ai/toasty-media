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

export function selectedDeviceLabel(select) {
  return select.selectedOptions[0]?.textContent || "";
}

export function fillSelect(select, devices, fallbackLabel) {
  const selected = select.value;
  const preferredDeviceId = fallbackLabel === "Camera" ? preferredCamera(devices)?.deviceId : "";
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
      return option;
    })
  );
  if (devices.some((device) => device.deviceId === selected)) {
    select.value = selected;
  } else if (preferredDeviceId) {
    select.value = preferredDeviceId;
  }
}

export async function hydrateDevices(microphoneSelect, cameraSelect) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(microphoneSelect, devices.filter((device) => device.kind === "audioinput"), "Microphone");
  fillSelect(cameraSelect, devices.filter((device) => device.kind === "videoinput"), "Camera");
}

// Full startPreview lifecycle (get media -> hydrate labels now that permission is granted -> restart if
// hydration picked a better default -> swap out an OBS/Camo virtual camera for a real one) as one call,
// since guest.js and host-prejoin.js both need the exact same sequence, not just the individual pieces.
export async function startDevicePreview({ videoEl, cameraSelect, microphoneSelect, previousStream }) {
  previousStream?.getTracks().forEach((track) => track.stop());
  const cameraBeforeHydration = cameraSelect.value;
  let stream = await getUserMediaWithFallback({
    video: deviceConstraint(cameraSelect.value, "video"),
    audio: deviceConstraint(microphoneSelect.value, "audio")
  });
  videoEl.srcObject = stream;
  await hydrateDevices(microphoneSelect, cameraSelect);

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
      const betterCamera = [...cameraSelect.options].find((option) => !isCamoCamera(option.textContent));
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
