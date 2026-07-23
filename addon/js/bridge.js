(function () {
  // WebHID Standard implementation with injected modal
  "use strict";
  const logger = webhid.import("logger");
  const http = webhid.import("http");
  const createSettingsStore = webhid.import("createSettingsStore");
  const GLOBAL_DEFAULTS = webhid.import("GLOBAL_DEFAULTS");
  const WebHidDevicePicker = webhid.import("WebHidDevicePicker");
  logger.initLogger("bridge");

  // ---------------------------------------------------------------------------
  // Initialize device picker custom element
  // ---------------------------------------------------------------------------
  const devicePicker = new WebHidDevicePicker();
  document.documentElement.appendChild(devicePicker.host);

  // ---------------------------------------------------------------------------
  // Content script ↔ Page bridge
  //
  // Page  →  content script:  port.postMessage({ id, action, payload })
  // Content script  →  page:  port.postMessage({ type: 'res', id, result })
  //                           port.postMessage({ type: 'evt', event })
  // ---------------------------------------------------------------------------
  const openDevices = new Set();
  const sessionTokens = new Map();

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getOpenDeviceIds") {
      sendResponse({ ids: Array.from(openDevices) });
      return true;
    }
  });
  const workers = new Map();
  const workerCallbacks = new Map();
  const workerReady = new Set();
  const workerQueues = new Map();
  const dataPorts = new Map();
  let wsPort = null;
  const settings = createSettingsStore(GLOBAL_DEFAULTS);
  settings.on("logLevel", (v) => logger.applyLevel(v));
  const pagePorts = new Map();
  const requestPortMap = new Map();
  const portOrigin = new Map();
  const spawnGen = new Map();

  async function isDeviceAllowedForOrigin(origin, deviceId) {
    if (!origin || !deviceId) return false;
    const key = encodeURIComponent(origin);
    const result = await browser.storage.local.get(key);
    return (result[key] || []).includes(deviceId);
  }

  async function despawnDataPlane(deviceId, { keepPort = false } = {}) {
    const gen = (spawnGen.get(deviceId) || 0) + 1;
    spawnGen.set(deviceId, gen);
    const worker = workers.get(deviceId);
    if (worker) {
      const port = dataPorts.get(deviceId);
      if (port && keepPort) {
        try {
          worker.postMessage({ type: "unsetPort" });
        } catch {}
        const returned = await new Promise((resolve) => {
          let done = false;
          const onMsg = (ev) => {
            if (done) return;
            if (ev.data && ev.data.type === "returnPort") {
              done = true;
              worker.onmessage = null;
              resolve((ev.ports && ev.ports[0]) || null);
            }
          };
          worker.onmessage = onMsg;
          setTimeout(() => {
            if (!done) {
              done = true;
              worker.onmessage = null;
              resolve(null);
            }
          }, 500);
        });
        if (returned) {
          dataPorts.set(deviceId, returned);
          returned.onmessage = (e) => onDataPortMessage(deviceId, e.data);
        }
      } else if (port) {
        dataPorts.delete(deviceId);
        try {
          worker.postMessage({ type: "unsetPort" });
        } catch {}
        try {
          port.onmessage = null;
          port.close();
        } catch {}
      }
      worker.terminate();
      workers.delete(deviceId);
    } else if (!keepPort) {
      const port = dataPorts.get(deviceId);
      if (port) {
        try {
          port.onmessage = null;
          port.close();
        } catch {}
        dataPorts.delete(deviceId);
      }
    }
    workerCallbacks.delete(deviceId);
    workerReady.delete(deviceId);
    workerQueues.delete(deviceId);
    // E5: Drop the spawn-generation counter for this device so the Map
    // does not grow unbounded across many open/close cycles. A fresh
    // spawnDataPlane call will re-seed it with gen=1.
    spawnGen.delete(deviceId);
  }

  async function refreshDataPlaneToken(deviceId) {
    if (workers.has(deviceId)) return;
    try {
      const resp = await browser.runtime.sendMessage({
        action: "open",
        deviceId,
      });
      if (http.isOk(resp.s) && resp.t) {
        sessionTokens.set(deviceId, resp.t);
        spawnDataPlane(deviceId, resp.t, resp.w || wsPort);
      } else {
        logger.error(
          "data plane token refresh failed for",
          deviceId,
          "s=" + (resp?.s || 0),
        );
      }
    } catch (e) {
      logger.error("data plane token refresh error:", e.message);
    }
  }

  async function spawnWorker(deviceId, sessionToken, wsPort, opts = {}, gen) {
    if (workers.has(deviceId)) return true;
    let worker;
    try {
      worker = new Worker(location.href);
    } catch (e) {
      logger.warn("redirect worker failed for", deviceId, ":", e.message);
    }
    if (!worker) return false;

    if (spawnGen.get(deviceId) !== gen) {
      logger.info("worker spawn stale, discarding for", deviceId);
      worker.terminate();
      return false;
    }
    workers.set(deviceId, worker);

    return new Promise((resolveSpawn) => {
      let resolved = false;
      let readyTimer = null;

      const fail = (reason) => {
        if (resolved) return;
        resolved = true;
        if (readyTimer) clearTimeout(readyTimer);
        worker.onerror = null;
        worker.onmessage = null;
        worker.terminate();
        workers.delete(deviceId);
        workerReady.delete(deviceId);
        dataPorts.delete(deviceId);
        const queue = workerQueues.get(deviceId);
        if (queue) {
          const cbMap = workerCallbacks.get(deviceId);
          for (const wMsg of queue) {
            if (cbMap && cbMap.has(wMsg.reqId)) {
              cbMap.get(wMsg.reqId)({ error: "worker spawn failed" });
              cbMap.delete(wMsg.reqId);
            }
          }
          workerQueues.delete(deviceId);
        }
        logger.warn("worker spawn failed for", deviceId, ":", reason);
        resolveSpawn(false);
      };

      worker.onerror = (e) => fail("onerror: " + (e.message || "unknown"));
      readyTimer = setTimeout(() => fail("ready timeout"), 3000);

      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          if (resolved) return;
          resolved = true;
          if (readyTimer) clearTimeout(readyTimer);
          logger.info("worker ready for", deviceId);
          workerReady.add(deviceId);
          const queue = workerQueues.get(deviceId);
          if (queue) {
            for (const wMsg of queue) {
              worker.postMessage(wMsg, wMsg.data ? [wMsg.data.buffer] : []);
            }
            workerQueues.delete(deviceId);
          }
          const port = dataPorts.get(deviceId);
          if (port) {
            port.onmessage = null;
            try {
              worker.postMessage({ type: "setPort" }, [port]);
            } catch (e) {
              logger.warn(
                "set-port transfer failed for",
                deviceId,
                ":",
                e.message,
              );
              port.onmessage = (e2) => onDataPortMessage(deviceId, e2.data);
            }
          }
          worker.postMessage({
            type: "settings",
            dataPlane: settings.dataPlane,
            fireAndForget: settings.fireAndForget,
            logLevel: settings.logLevel,
          });
          resolveSpawn(true);
          return;
        }
        if (data.type === "auth-failed") {
          logger.warn(
            "worker auth-failed for",
            deviceId,
            "code=" + data.code + "; re-opening",
          );
          // E1 (consistency): also resolve orphaned callbacks on auth-failed so
          // in-flight sendReport/receiveFeatureReport do not dangle while the
          // token refresh is in progress.
          const orphanCbMap = workerCallbacks.get(deviceId);
          if (orphanCbMap) {
            for (const [, cb] of orphanCbMap)
              cb({ error: "worker auth-failed" });
            orphanCbMap.clear();
          }
          workers.delete(deviceId);
          workerReady.delete(deviceId);
          dataPorts.delete(deviceId);
          refreshDataPlaneToken(deviceId);
          return;
        }
        if (data.type === "closed") {
          logger.warn("worker closed for", deviceId);
          // E1: Resolve any pending worker callbacks so callers' Promises
          // do not hang forever when the data worker dies unexpectedly.
          // Mirrors the _controlPending pattern used on the control plane.
          const orphanCbMap = workerCallbacks.get(deviceId);
          if (orphanCbMap) {
            for (const [, cb] of orphanCbMap) cb({ error: "worker closed" });
            orphanCbMap.clear();
          }
          workers.delete(deviceId);
          workerReady.delete(deviceId);
          dataPorts.delete(deviceId);
          replyToPage({
            type: "evt",
            event: { eventType: "disconnect", deviceId: deviceId },
          });
          return;
        }
        if (data.type === "inputReport") {
          const view = data.data ? new Uint8Array(data.data) : null;
          if (view && logger.level >= 3 && data.reportId !== 33) {
            let hex = "";
            for (let i = 0; i < Math.min(8, view.length); i++)
              hex += view[i].toString(16).padStart(2, "0") + " ";
            logger.debug(
              "worker→page inputReport device=" +
                deviceId +
                " reportId=" +
                data.reportId +
                " len=" +
                view.length +
                " first8=" +
                hex,
            );
          }
          replyToPage(
            {
              type: "evt",
              event: {
                eventType: "input_report",
                deviceId: deviceId,
                reportId: data.reportId,
                data: view,
              },
            },
            view ? [view.buffer] : [],
          );
          return;
        }
        if (data.type === "sendResult" || data.type === "featureResult") {
          const cbMap = workerCallbacks.get(deviceId);
          if (cbMap && cbMap.has(data.reqId)) {
            const cb = cbMap.get(data.reqId);
            cbMap.delete(data.reqId);
            if (data.error) cb({ s: 500 });
            else if (data.data) cb({ s: 200, d: data.data });
            else cb({ s: 204 });
          }
        }
      };

      worker.postMessage({
        type: "connect",
        wsPort,
        token: sessionToken,
        reportSize: opts.reportSize || 64,
        logLevel: logger.level,
      });
    });
  }

  async function spawnDataPlane(deviceId, sessionToken, wsPort, opts = {}) {
    const gen = (spawnGen.get(deviceId) || 0) + 1;
    spawnGen.set(deviceId, gen);
    const ok = await spawnWorker(deviceId, sessionToken, wsPort, opts, gen);
    if (!ok && spawnGen.get(deviceId) === gen) {
      logger.warn("worker spawn failed for", deviceId, "; falling back to NM");
      browser.runtime
        .sendMessage({
          action: "setDataPlane",
          deviceId: deviceId,
          mode: "nm",
        })
        .catch(() => {});
    }
  }

  (async () => {
    try {
      const resp = await browser.runtime.sendMessage({ action: "handshake" });
      if (http.isOk(resp.s) && resp.w) {
        wsPort = resp.w;
        const global = await browser.storage.local.get(GLOBAL_DEFAULTS);
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          for (const k of Object.keys(GLOBAL_DEFAULTS)) {
            if (ss[k] !== undefined) global[k] = ss[k];
          }
        }
        settings.set(global);
      }
    } catch (e) {
      logger.warn("handshake failed:", e.message);
    }
  })();

  function replyToPage(msg, transfer) {
    if (msg?.id != null) {
      const port = requestPortMap.get(msg.id);
      if (port) {
        requestPortMap.delete(msg.id);
        port.postMessage(msg, transfer);
        return;
      }
    }
    if (msg?.type === "evt" || msg?.type === "settings") {
      for (const port of pagePorts.values()) port.postMessage(msg, transfer);
    }
  }

  window.addEventListener("message", (event) => {
    const port = event.ports?.[0];
    if (!port) return;
    if (pagePorts.has(event.source)) return;
    pagePorts.set(event.source, port);
    portOrigin.set(port, event.origin);
    port.onmessage = (ev) => {
      if (ev.data?.id != null) requestPortMap.set(ev.data.id, port);
      handleRequest(ev.data, ev.ports);
    };
    logger.debug(
      "[bridge] page port established for",
      event.source === window ? "window" : "child",
    );
  });

  function getRequestOrigin(data) {
    const port = requestPortMap.get(data.id);
    return port ? portOrigin.get(port) : window.location.origin;
  }

  async function handleRequest(data, ports) {
    if (!data || data.id === undefined) return;

    const { id, action: reqAction, payload } = data;
    let action = reqAction;
    const isFireAndForget = data.fireAndForget === true;
    logger.debug(
      "req action=" + action + " id=" + id + (isFireAndForget ? " (faf)" : ""),
    );

    if (action === "dataPort") {
      const deviceId = payload.deviceId;
      const port = ports && ports[0];
      if (!deviceId || !port) {
        logger.warn("data-port: missing deviceId or port");
        return;
      }
      dataPorts.set(deviceId, port);
      logger.debug("data port received for device", deviceId);
      const worker = workers.get(deviceId);
      if (worker && workerReady.has(deviceId)) {
        try {
          worker.postMessage({ type: "setPort" }, [port]);
        } catch (e) {
          logger.warn("set-port transfer failed for", deviceId, ":", e.message);
          port.onmessage = (ev) => onDataPortMessage(deviceId, ev.data);
        }
      } else {
        port.onmessage = (ev) => onDataPortMessage(deviceId, ev.data);
      }
      return;
    }

    if (action === "getSettings") {
      try {
        const global = await browser.storage.local.get(GLOBAL_DEFAULTS);
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          for (const k of Object.keys(GLOBAL_DEFAULTS)) {
            if (ss[k] !== undefined) global[k] = ss[k];
          }
        }
        settings.set(global);
        replyToPage({ type: "res", id, result: global });
      } catch (e) {
        replyToPage({ type: "res", id, result: {} });
      }
      return;
    }

    if (
      (action === "sendReport" ||
        action === "sendFeatureReport" ||
        action === "receiveFeatureReport") &&
      payload &&
      payload.deviceId &&
      workers.has(payload.deviceId)
    ) {
      action =
        action === "sendReport"
          ? "workerSend"
          : action === "sendFeatureReport"
            ? "workerSendFeature"
            : "workerReceiveFeature";
    }

    // Hot-path actions: use worker WS → NM (priority order).
    if (
      action === "workerSend" ||
      action === "workerSendFeature" ||
      action === "workerReceiveFeature"
    ) {
      const deviceId = payload.deviceId;

      // Worker WS data plane.
      const worker = workers.get(deviceId);
      if (worker && workerReady.has(deviceId)) {
        const wType =
          action === "workerSend"
            ? "send"
            : action === "workerSendFeature"
              ? "sendFeature"
              : "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.reportId };
        if (action === "workerSend" || action === "workerSendFeature")
          wMsg.data = payload.data;

        if (!isFireAndForget || action === "workerReceiveFeature") {
          let cbMap = workerCallbacks.get(deviceId);
          if (!cbMap) {
            cbMap = new Map();
            workerCallbacks.set(deviceId, cbMap);
          }
          cbMap.set(id, (data) => {
            const result = data.error
              ? { s: 500 }
              : data.data
                ? { s: 200, d: data.data }
                : { s: 204 };
            const xfers =
              result.d instanceof Uint8Array ? [result.d.buffer] : [];
            replyToPage(
              { type: "res", id, result },
              xfers.length ? xfers : undefined,
            );
          });
        }
        worker.postMessage(wMsg);
        return;
      }

      if (worker) {
        const wType =
          action === "workerSend"
            ? "send"
            : action === "workerSendFeature"
              ? "sendFeature"
              : "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.reportId };
        if (action === "workerSend" || action === "workerSendFeature")
          wMsg.data = payload.data;

        if (!isFireAndForget || action === "workerReceiveFeature") {
          let cbMap = workerCallbacks.get(deviceId);
          if (!cbMap) {
            cbMap = new Map();
            workerCallbacks.set(deviceId, cbMap);
          }
          cbMap.set(id, (data) => {
            const result = data.error
              ? { s: 500 }
              : data.data
                ? { s: 200, d: data.data }
                : { s: 204 };
            const xfers =
              result.d instanceof Uint8Array ? [result.d.buffer] : [];
            replyToPage(
              { type: "res", id, result },
              xfers.length ? xfers : undefined,
            );
          });
        }

        if (!workerQueues.has(deviceId)) workerQueues.set(deviceId, []);
        workerQueues.get(deviceId).push(wMsg);
        return;
      }

      logger.warn("no worker for", deviceId, "; falling back to NM");
      const fallbackAction =
        action === "workerSend"
          ? "sendReport"
          : action === "workerSendFeature"
            ? "sendFeatureReport"
            : "receiveFeatureReport";
      try {
        const msg = Object.assign({ action: fallbackAction }, payload || {});
        if (isFireAndForget && action !== "workerReceiveFeature") {
          browser.runtime.sendMessage(msg).catch(() => {});
          return;
        }
        const response = await browser.runtime.sendMessage(msg);
        const xfers =
          response && response.d instanceof Uint8Array
            ? [response.d.buffer]
            : [];
        replyToPage(
          { type: "res", id, result: response },
          xfers.length ? xfers : undefined,
        );
      } catch (error) {
        replyToPage({ type: "res", id, result: { s: 500 } });
      }
      return;
    }

    if (action === "requestDevice") {
      const filters = (payload && payload.filters) || [];
      const exclusionFilters = (payload && payload.exclusionFilters) || [];

      if (
        settings.devicePickerMode === "pageAction" ||
        settings.devicePickerMode === "window"
      ) {
        browser.runtime
          .sendMessage({
            action: "showPicker",
            requestId: id,
            filters,
            exclusionFilters,
            origin: getRequestOrigin(data),
            mode: settings.devicePickerMode,
          })
          .catch(() => {});
        const pickerTimeout = setTimeout(() => {
          replyToPage({
            type: "res",
            id,
            result: { cancelled: true },
          });
        }, 30000);
        const onPickerResult = (msg) => {
          if (msg.action !== "pickerResult" || msg.requestId !== id) return;
          clearTimeout(pickerTimeout);
          browser.runtime.onMessage.removeListener(onPickerResult);
          if (msg.selected && msg.devices) {
            replyToPage({
              type: "res",
              id,
              result: { devices: msg.devices },
            });
          } else {
            replyToPage({
              type: "res",
              id,
              result: { cancelled: true },
            });
          }
        };
        browser.runtime.onMessage.addListener(onPickerResult);
        return;
      }

      let onSelected, onCancelled;
      const cleanup = () => {
        window.removeEventListener("webhid-device-selected", onSelected);
        window.removeEventListener("webhid-device-cancelled", onCancelled);
      };
      onSelected = (e) => {
        cleanup();
        replyToPage({
          type: "res",
          id,
          result: { devices: e.detail.devices },
        });
      };
      onCancelled = () => {
        cleanup();
        replyToPage({
          type: "res",
          id,
          result: { cancelled: true },
        });
      };
      window.addEventListener("webhid-device-selected", onSelected);
      window.addEventListener("webhid-device-cancelled", onCancelled);
      devicePicker.show(filters, exclusionFilters);
      return;
    }

    try {
      let response;
      if (action === "open") {
        const origin = getRequestOrigin(data);
        const allowed = await isDeviceAllowedForOrigin(
          origin,
          payload.deviceId,
        );
        if (!allowed) {
          replyToPage({ type: "res", id, result: { s: 403 } });
          return;
        }
      }
      const msg = Object.assign(
        { action, origin: getRequestOrigin(data) },
        payload || {},
      );
      response = await browser.runtime.sendMessage(msg);

      if (action === "open" && http.isOk(response.s) && response.t) {
        const deviceId = response.i;
        openDevices.add(deviceId);
        sessionTokens.set(deviceId, response.t);
        browser.runtime
          .sendMessage({
            action: "deviceCountChanged",
            count: openDevices.size,
          })
          .catch(() => {});
        logger.debug("open ok deviceId=" + deviceId + " wsPort=" + response.w);

        const dataPlane = settings.dataPlane;
        if (dataPlane === "ws") {
          spawnDataPlane(deviceId, response.t, response.w || wsPort);
        }
      }

      if (action === "close") {
        const deviceId = payload.deviceId;
        logger.debug("close deviceId=" + deviceId);
        openDevices.delete(deviceId);
        sessionTokens.delete(deviceId);
        browser.runtime
          .sendMessage({
            action: "deviceCountChanged",
            count: openDevices.size,
          })
          .catch(() => {});
        despawnDataPlane(deviceId);
      }

      const xfers =
        response && response.d instanceof Uint8Array ? [response.d.buffer] : [];
      replyToPage(
        { type: "res", id, result: response },
        xfers.length ? xfers : undefined,
      );
    } catch (error) {
      replyToPage({ type: "res", id, result: { s: 500 } });
    }
  }

  // E4: Drop all bridge-side device state when background signals the NM
  // host (or daemon) has restarted. Emits a disconnect event for each
  // previously-open device so the page can recover by calling open() again.
  function handleGlobalReset() {
    logger.warn("global reset: clearing bridge device state");
    const deviceIds = Array.from(openDevices);
    openDevices.clear();
    sessionTokens.clear();
    for (const deviceId of deviceIds) {
      try {
        despawnDataPlane(deviceId);
      } catch (e) {
        logger.warn("global reset: despawn failed for", deviceId, e.message);
      }
      // Notify page world that this device is no longer usable as-is.
      replyToPage({
        type: "evt",
        event: { eventType: "disconnect", deviceId },
      });
    }
    browser.runtime
      .sendMessage({ action: "deviceCountChanged", count: 0 })
      .catch(() => {});
  }

  // Forward events pushed by background.js into the page world.
  browser.runtime.onMessage.addListener((message) => {
    // E4: When the NM host dies and respawns, daemon-side per-device state
    // (session tokens, open handles) is gone. Any cached sessionTokens /
    // openDevices on the bridge side are now stale — clear them and emit
    // disconnect events to the page so app code can recover (re-open).
    if (message.action === "globalReset") {
      handleGlobalReset();
      return;
    }
    if (message.action === "webhidDeviceEvent" && message.event) {
      const ev = message.event;
      if (ev.eventType === "input_report") {
        const port = dataPorts.get(ev.deviceId);
        if (port) {
          const view = ev.data;
          const buf = view ? view.buffer || view : null;
          try {
            port.postMessage(
              { type: "inputReport", reportId: ev.reportId, data: buf },
              buf ? [buf] : [],
            );
          } catch {}
          return;
        }
      }
      if (ev.eventType === "disconnect") {
        const port = dataPorts.get(ev.deviceId);
        if (port) {
          try {
            port.postMessage({ type: "disconnect" });
          } catch {}
        }
      }
      if (
        devicePicker &&
        devicePicker.isOpen &&
        (ev.eventType === "connect" || ev.eventType === "disconnect")
      ) {
        devicePicker.refreshDevices();
      }
      replyToPage({ type: "evt", event: ev });
    }
  });

  function onDataPortMessage(deviceId, msg) {
    if (!msg) return;
    if (
      msg.type === "send" ||
      msg.type === "sendFeature" ||
      msg.type === "receiveFeature"
    ) {
      const action =
        msg.type === "send"
          ? "sendReport"
          : msg.type === "sendFeature"
            ? "sendFeatureReport"
            : "receiveFeatureReport";
      const payload = { deviceId, reportId: msg.reportId };
      if (msg.type === "send" || msg.type === "sendFeature")
        payload.data = msg.data;
      const port = dataPorts.get(deviceId);
      const cb = (response) => {
        if (!port) return;
        if (msg.type === "receiveFeature") {
          const data =
            response && http.isOk(response.s) && response.d ? response.d : null;
          try {
            port.postMessage({
              type: "featureResult",
              reqId: msg.reqId,
              data: data || null,
            });
          } catch {}
        } else {
          const err = response && !http.isOk(response.s) ? "send failed" : null;
          try {
            port.postMessage({
              type: msg.type === "send" ? "sendResult" : "featureResult",
              reqId: msg.reqId,
              error: err,
            });
          } catch {}
        }
      };
      const m = Object.assign({ action }, payload);
      browser.runtime
        .sendMessage(m)
        .then(cb)
        .catch(() => cb({ s: 500 }));
      return;
    }
  }

  // ── Settings observer ─────────────────────────────────────────────

  async function applyDataPlane(dp) {
    for (const id of openDevices) {
      await despawnDataPlane(id, { keepPort: true });
    }
    if (dp === "ws") {
      for (const id of openDevices) {
        const token = sessionTokens.get(id);
        if (token) spawnDataPlane(id, token, wsPort);
      }
    } else {
      for (const id of openDevices) {
        const port = dataPorts.get(id);
        if (port && !port.onmessage) {
          port.onmessage = (ev) => onDataPortMessage(id, ev.data);
        }
      }
    }
    for (const id of openDevices) {
      browser.runtime
        .sendMessage({
          action: "setDataPlane",
          deviceId: id,
          mode: dp,
        })
        .catch(() => {});
    }
    logger.info("data plane changed:", dp, "open devices:", openDevices.size);
  }

  settings.on("dataPlane", (dp) => applyDataPlane(dp));

  // Push any settings change to page + workers.
  settings.on(["dataPlane", "fireAndForget", "logLevel"], () => {
    const all = settings.getAll();
    const patch = {};
    for (const k of ["dataPlane", "fireAndForget", "logLevel"]) {
      patch[k] = all[k];
    }
    replyToPage({ type: "settings", settings: patch });
    const workerMsg = { type: "settings", ...patch };
    for (const worker of workers.values()) worker.postMessage(workerMsg);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const origin = window.location.origin;
    const siteKey = origin ? `site:${origin}` : null;
    const patch = {};
    for (const k of Object.keys(GLOBAL_DEFAULTS)) {
      if (changes[k]) patch[k] = changes[k].newValue;
    }
    if (siteKey && changes[siteKey]) {
      const ss = changes[siteKey].newValue || {};
      for (const k of Object.keys(ss)) patch[k] = ss[k];
    }
    if (Object.keys(patch).length === 0) return;
    settings.set(patch);
  });
})();
