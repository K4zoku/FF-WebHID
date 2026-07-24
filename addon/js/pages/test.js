"use strict";

document.getElementById("btn-clear-log").addEventListener("click", () => {
  document.getElementById("log").replaceChildren();
});

// ── Logging ────────────────────────────────────────────────────────────────────
const $log = document.getElementById("log");
function log(msg, cls = "log-info") {
  const ts = new Date().toTimeString().slice(0, 8);
  const div = document.createElement("div");
  div.className = `log-entry ${cls}`;
  const span = document.createElement("span");
  span.className = "log-ts";
  span.textContent = ts + " ";
  div.appendChild(span);
  div.appendChild(document.createTextNode(msg));
  $log.prepend(div);
}
function logOk(m) {
  log("✓ " + m, "log-ok");
}
function logErr(m) {
  log("✗ " + m, "log-err");
}
function logWarn(m) {
  log("⚠ " + m, "log-warn");
}
function logData(m) {
  log(m, "log-data");
}
function logEvent(m) {
  log("⚡ " + m, "log-event");
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hexBytes(arr) {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

// ── State ──────────────────────────────────────────────────────────────────────
let selectedDevice = null; // HIDDevice instance (primary)
let selectedDevices = []; // array of HIDDevice instances returned by requestDevice
let inputReportListener = null;
let eventCount = 0;

function deviceLabel(d) {
  return `${d.productName || "device"} [${(d.vendorId || 0).toString(16).padStart(4, "0")}:${(d.productId || 0).toString(16).padStart(4, "0")}]`;
}

function sameDevice(a, b) {
  if (!a || !b) return false;
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.serialNumber || "") === (b.serialNumber || "")
  );
}

function isDeviceSelected(dev) {
  if (selectedDevices && selectedDevices.length) {
    return selectedDevices.some((d) => sameDevice(d, dev));
  }
  return selectedDevice ? sameDevice(selectedDevice, dev) : false;
}

function updateUIForSelected() {
  const primary =
    selectedDevices.length > 0 ? selectedDevices[0] : selectedDevice;
  // badge shows primary or count
  if (selectedDevices.length > 1) {
    setBadge(
      "badge-dev",
      `${deviceLabel(primary)} (+${selectedDevices.length - 1} more)`,
      null,
    );
  } else if (primary) {
    setBadge("badge-dev", deviceLabel(primary), null);
  } else {
    setBadge("badge-dev", "no device selected", null);
  }

  const anyOpened =
    selectedDevices.length > 0
      ? selectedDevices.some((d) => d.opened)
      : primary
        ? primary.opened
        : false;
  const anyClosed =
    selectedDevices.length > 0
      ? selectedDevices.some((d) => !d.opened)
      : primary
        ? !primary.opened
        : false;

  document.getElementById("btn-open").disabled = !anyClosed; // enable if any device is closed
  document.getElementById("btn-close").disabled = !anyOpened;

  // Standard I/O buttons
  document.getElementById("btn-listen").disabled = !anyOpened;
  document.getElementById("btn-send-report").disabled = !anyOpened;
  document.getElementById("btn-send-feature").disabled = !anyOpened;
  document.getElementById("btn-receive-feature").disabled = !anyOpened;
}

// ── Badge helpers ──────────────────────────────────────────────────────────────
function setBadge(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className =
    "badge " +
    (ok === true ? "badge-ok" : ok === false ? "badge-err" : "badge-warn");
}

// ── API availability check ─────────────────────────────────────────────────────
window.addEventListener("load", () => {
  if (typeof navigator.hid !== "undefined") {
    setBadge("badge-api", "API: available ✓", true);
    logOk("navigator.hid is available (addon is loaded)");
  } else {
    setBadge("badge-api", "API: missing ✗", false);
    logErr("navigator.hid is NOT available");
    logWarn(
      "Load the addon: about:debugging → This Firefox → Load Temporary Add-on → addon/manifest.json",
    );
    logWarn(
      "The page must be served over http:// – file:// URLs may not get content scripts.",
    );
  }
});

// ── Enumerate ─────────────────────────────────────────────────────────────────
document.getElementById("btn-enumerate").addEventListener("click", async () => {
  log("Enumerating…");
  try {
    const devices = await navigator.hid.getDevices();
    if (devices.length === 0) {
      logWarn(
        'No devices returned. Try "Request Device…" to grant access first.',
      );
    } else {
      logOk(`${devices.length} device(s) found`);
    }
    renderDeviceList(devices);
    setBadge("badge-nm", `NM: ok (${devices.length} dev)`, true);
  } catch (e) {
    logErr("Enumerate failed: " + e.message);
    setBadge("badge-nm", "NM: error", false);
  }
});

// ── Request Device ────────────────────────────────────────────────────────────
document.getElementById("btn-request").addEventListener("click", async () => {
  log("Requesting device (picker will open)…");
  try {
    // The API now returns an array of selected devices (even for single selections)
    const devices = await navigator.hid.requestDevice({ filters: [] });
    if (Array.isArray(devices) && devices.length > 0) {
      // Remember full returned array and pick the first as the primary for UI actions
      selectedDevices = devices;
      const device = devices[0];
      if (devices.length === 1) {
        logOk(`Selected: ${deviceLabel(device)}`);
      } else {
        logOk(
          `Selected ${devices.length} devices, primary: ${deviceLabel(device)}`,
        );
      }
      // Update UI selection to the primary device (selectDevice sets selectedDevices to [dev])
      selectedDevice = device;
      // Keep selectedDevices as the full array
      updateUIForSelected();
      // Re-render device list highlight
      navigator.hid
        .getDevices()
        .then(renderDeviceList)
        .catch(() => {});
      setBadge("badge-nm", "NM: ok", true);
    } else {
      log("Picker cancelled");
    }
  } catch (e) {
    logErr("Request failed: " + e.message);
  }
});

// ── Device list rendering ─────────────────────────────────────────────────────
function renderDeviceList(devices) {
  const list = document.getElementById("device-list");
  list.replaceChildren();
  if (devices.length === 0) {
    const empty = document.createElement("span");
    empty.style.cssText = "color:var(--muted);font-size:.8rem";
    empty.textContent = "No devices";
    list.appendChild(empty);
    return;
  }
  devices.forEach((dev) => {
    const card = document.createElement("div");
    card.className =
      "device-card" +
      (isDeviceSelected(dev) ? " selected" : "") +
      (dev.opened ? " opened" : "");
    const vid = document.createElement("div");
    vid.className = "device-vid";
    vid.textContent =
      dev.vendorId.toString(16).padStart(4, "0") +
      "\n" +
      dev.productId.toString(16).padStart(4, "0");
    vid.style.whiteSpace = "pre";
    const name = document.createElement("div");
    name.className = "device-name";
    name.textContent = dev.productName || "(no name)";
    const path = document.createElement("div");
    path.className = "device-path";
    path.textContent =
      (dev.manufacturer || "") + " · " + (dev.serialNumber || "");
    card.appendChild(vid);
    card.appendChild(name);
    card.appendChild(path);
    card.addEventListener("click", () => selectDevice(dev));
    list.appendChild(card);
  });
}

function selectDevice(dev) {
  selectedDevice = dev;
  // When a device is selected from the list by the user, treat it as the sole selected device
  selectedDevices = [dev];
  log(`Selected: ${dev.productName}`);
  // Re-render to show selection highlight
  navigator.hid
    .getDevices()
    .then(renderDeviceList)
    .catch(() => {});
  updateUIForSelected();
}

// ── Open ──────────────────────────────────────────────────────────────────────
document.getElementById("btn-open").addEventListener("click", async () => {
  // Open all selected devices
  const toOpen =
    Array.isArray(selectedDevices) && selectedDevices.length > 0
      ? selectedDevices
      : selectedDevice
        ? [selectedDevice]
        : [];
  if (toOpen.length === 0) return;
  try {
    await Promise.all(
      toOpen.map(async (d) => {
        try {
          if (!d.opened) await d.open();
        } catch (e) {
          logErr(`Open ${deviceLabel(d)} failed: ${e.message}`);
        }
      }),
    );
    logOk(`Opened ${toOpen.length} device(s)`);
    updateUIForSelected();
  } catch (e) {
    logErr("Open failed: " + e.message);
  }
});

// ── Close ─────────────────────────────────────────────────────────────────────
document.getElementById("btn-close").addEventListener("click", async () => {
  if (
    !selectedDevice &&
    (!Array.isArray(selectedDevices) || selectedDevices.length === 0)
  )
    return;
  stopListening();
  try {
    // Close all selected devices (the API may have returned multiple interfaces)
    const toClose =
      Array.isArray(selectedDevices) && selectedDevices.length > 0
        ? selectedDevices
        : [selectedDevice];
    await Promise.all(
      toClose.map(async (d) => {
        try {
          if (d.opened) await d.close();
        } catch (e) {
          /* ignore per-device errors */
        }
      }),
    );
    logOk("Closed");
    updateUIForSelected();
  } catch (e) {
    logErr("Close failed: " + e.message);
  }
});

// ── sendReport ────────────────────────────────────────────────────────────────
document
  .getElementById("btn-send-report")
  .addEventListener("click", async () => {
    const toWrite =
      Array.isArray(selectedDevices) && selectedDevices.length > 0
        ? selectedDevices
        : selectedDevice
          ? [selectedDevice]
          : [];
    if (toWrite.length === 0) return;

    const reportId =
      parseInt(document.getElementById("output-report-id").value) || 0;
    const hex = document.getElementById("output-hex").value.trim();
    const bytes = hex
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
    if (bytes.some(isNaN)) {
      logErr("Invalid hex bytes");
      return;
    }

    try {
      await Promise.all(
        toWrite.map(async (d) => {
          try {
            if (d.opened) {
              await d.sendReport(reportId, new Uint8Array(bytes));
              logOk(
                `sendReport(${reportId}) to ${deviceLabel(d)}: ${hexBytes(bytes)}`,
              );
            }
          } catch (e) {
            logErr(`sendReport ${deviceLabel(d)}: ${e.message}`);
          }
        }),
      );
    } catch (e) {
      logErr("sendReport overall failed: " + e.message);
    }
  });

// ── Feature Reports ───────────────────────────────────────────────────────────
document
  .getElementById("btn-receive-feature")
  .addEventListener("click", async () => {
    const toRead =
      Array.isArray(selectedDevices) && selectedDevices.length > 0
        ? selectedDevices
        : selectedDevice
          ? [selectedDevice]
          : [];
    if (toRead.length === 0) return;

    const reportId =
      parseInt(document.getElementById("feature-report-id").value) || 0;

    for (const d of toRead) {
      if (!d.opened) continue;
      try {
        const view = await d.receiveFeatureReport(reportId);
        const bytes = new Uint8Array(view.buffer);
        logData(
          `receiveFeatureReport(${reportId}) from ${deviceLabel(d)}: ${hexBytes(bytes)}`,
        );
      } catch (e) {
        logErr(
          `receiveFeatureReport(${reportId}) ${deviceLabel(d)}: ${e.message}`,
        );
      }
    }
  });

document
  .getElementById("btn-send-feature")
  .addEventListener("click", async () => {
    const toWrite =
      Array.isArray(selectedDevices) && selectedDevices.length > 0
        ? selectedDevices
        : selectedDevice
          ? [selectedDevice]
          : [];
    if (toWrite.length === 0) return;

    const reportId =
      parseInt(document.getElementById("feature-report-id").value) || 0;
    const hex = document.getElementById("feature-hex").value.trim();
    const bytes = hex
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
    if (bytes.some(isNaN)) {
      logErr("Invalid hex bytes");
      return;
    }

    try {
      await Promise.all(
        toWrite.map(async (d) => {
          try {
            if (d.opened) {
              await d.sendFeatureReport(reportId, new Uint8Array(bytes));
              logOk(
                `sendFeatureReport(${reportId}) to ${deviceLabel(d)}: ${hexBytes(bytes)}`,
              );
            }
          } catch (e) {
            logErr(`sendFeatureReport ${deviceLabel(d)}: ${e.message}`);
          }
        }),
      );
    } catch (e) {
      logErr("sendFeatureReport overall failed: " + e.message);
    }
  });

// ── inputreport events ────────────────────────────────────────────────────────
document.getElementById("btn-listen").addEventListener("click", startListening);
document
  .getElementById("btn-unlisten")
  .addEventListener("click", stopListening);

function startListening() {
  const toListen =
    Array.isArray(selectedDevices) && selectedDevices.length > 0
      ? selectedDevices
      : selectedDevice
        ? [selectedDevice]
        : [];
  if (toListen.length === 0 || inputReportListener) return;
  eventCount = 0;
  inputReportListener = (e) => {
    eventCount++;
    document.getElementById("event-count").textContent = `${eventCount} events`;
    const bytes = new Uint8Array(e.data.buffer);
    const deviceName = e.device ? e.device.productName || "device" : "";
    logEvent(
      `inputreport from ${deviceName} reportId=${e.reportId}  ${hexBytes(bytes)}`,
    );
  };
  toListen.forEach((d) =>
    d.addEventListener("inputreport", inputReportListener),
  );
  document.getElementById("btn-listen").disabled = true;
  document.getElementById("btn-unlisten").disabled = false;
  logOk(
    "Listening for inputreport events on " + toListen.length + " device(s)",
  );
}

function stopListening() {
  const toListen =
    Array.isArray(selectedDevices) && selectedDevices.length > 0
      ? selectedDevices
      : selectedDevice
        ? [selectedDevice]
        : [];
  if (toListen.length === 0 || !inputReportListener) return;
  toListen.forEach((d) => {
    try {
      d.removeEventListener("inputreport", inputReportListener);
    } catch (e) {}
  });
  inputReportListener = null;
  document.getElementById("btn-listen").disabled = false;
  document.getElementById("btn-unlisten").disabled = true;
  log("Stopped listening");
}
