(function () {
  // WebHID Standard implementation with injected modal
  "use strict";
  const logger = __webhid.import("logger");
  const fetchResource = __webhid.import("fetchResource");
  const http = __webhid.import("http");
  const guessDeviceType = __webhid.import("guessDeviceType");
  const createSettingsStore = __webhid.import("createSettingsStore");
  const GLOBAL_DEFAULTS = __webhid.import("GLOBAL_DEFAULTS");
  const WebHidDevicePicker = __webhid.import("WebHidDevicePicker");
  logger.initLogger("bridge");

  // ---------------------------------------------------------------------------
  // Initialize device picker custom element
  // ---------------------------------------------------------------------------
  const devicePicker = new WebHidDevicePicker();
  document.documentElement.appendChild(devicePicker.host);

  // ---------------------------------------------------------------------------
  // Content script ↔ Page bridge
  //
  // Page  →  content script:  port.postMessage({ __webhid_bridge: 'req', id, action, payload })
  // Content script  →  page:  port.postMessage({ __webhid_bridge: 'res', id, result })
  //                           port.postMessage({ __webhid_bridge: 'evt', event })
  // ---------------------------------------------------------------------------
  const _openDevices = new Set();
  const _sessionTokens = new Map();

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getOpenDeviceIds") {
      sendResponse({ ids: Array.from(_openDevices) });
      return true;
    }
  });
  const _workers = new Map();
  const _workerCallbacks = new Map();
  const _workerReady = new Set();
  const _workerQueues = new Map();
  const _dataPorts = new Map();
  let _wsPort = null;
  const settings = createSettingsStore(GLOBAL_DEFAULTS);
  let _controlWorker = null;
  let _controlPort = null;
  let _pagePort = null;
  const _controlPending = new Map();
  let _controlReqId = 1;
  const _spawnGen = new Map();

  const _workerBlobUrls = { worker: null, control: null };

  async function _getWorkerBlobUrl(kind) {
    if (_workerBlobUrls[kind]) return _workerBlobUrls[kind];
    const baseUrls = [
      "js/utils/bootstrap.js",
      "js/utils/logger.js",
      "js/utils/settings.js",
      "js/utils/websocket.js",
    ];
    const workerUrl = kind === "control" ? "js/control.js" : "js/worker.js";
    const texts = await Promise.all(
      [...baseUrls, workerUrl].map((u) => fetchResource(u)),
    );
    const blob = new Blob([texts.join("\n")], {
      type: "application/javascript",
    });
    const url = URL.createObjectURL(blob);
    _workerBlobUrls[kind] = url;
    return url;
  }

  function _getWorkerRedirectUrl() {
    const u = new URL(location.href);
    u.searchParams.set("__webhid_wkr", "1");
    return u.href;
  }

  async function _spawnControlWorker(token, wsPort) {
    if (_controlWorker) return;
    let cspBlocked = false;
    try {
      const check = await browser.runtime.sendMessage({
        action: "checkWorkerCsp",
      });
      cspBlocked = !!check?.blocked;
    } catch {}
    if (cspBlocked) {
      logger.warn(
        "control worker skipped: CSP worker-src blocks blob:; control plane uses NM",
      );
      return;
    }
    let worker;
    try {
      const url = await _getWorkerBlobUrl("control");
      worker = new Worker(url);
    } catch (e) {
      logger.error("control worker spawn failed:", e);
      return;
    }

    const { port1, port2 } = new MessageChannel();
    _controlPort = port1;
    _controlWorker = worker;

    let resolved = false;
    let readyTimer = null;

    const fail = (reason) => {
      if (resolved) return;
      resolved = true;
      if (readyTimer) clearTimeout(readyTimer);
      _terminateControlWorker();
      logger.warn(
        "control worker failed:",
        reason,
        "; control plane falls back to NM",
      );
    };

    worker.onerror = (e) => fail("onerror: " + (e.message || "unknown"));
    readyTimer = setTimeout(() => fail("ready timeout"), 3000);

    _controlPort.onmessage = ({ data }) => {
      if (data.type === "ready") {
        if (resolved) return;
        resolved = true;
        if (readyTimer) clearTimeout(readyTimer);
        logger.info("control worker ready");
      } else if (data.type === "closed") {
        logger.warn("control worker WS closed; will auto-reconnect");
        for (const [, { resolve }] of _controlPending) resolve({ s: 503 });
        _controlPending.clear();
      } else if (data.type === "auth-failed") {
        logger.warn(
          "control worker auth-failed code=" + data.code + "; re-handshaking",
        );
        for (const [, { resolve }] of _controlPending) resolve({ s: 503 });
        _controlPending.clear();
        _terminateControlWorker();
        _refreshControlToken();
      } else if (
        data.type === "response" &&
        data.id &&
        _controlPending.has(data.id)
      ) {
        const { resolve } = _controlPending.get(data.id);
        _controlPending.delete(data.id);
        resolve(data.result);
      }
    };

    _controlWorker.postMessage(
      { type: "connect", token, wsPort, logLevel: logger._level },
      [port2],
    );
    logger.info("control worker spawned");
  }

  function _terminateControlWorker() {
    if (_controlPort) {
      _controlPort.onmessage = null;
      _controlPort.close();
      _controlPort = null;
    }
    if (_controlWorker) {
      _controlWorker.postMessage({ type: "disconnect" });
      _controlWorker.terminate();
      _controlWorker = null;
    }
    for (const [, { resolve }] of _controlPending) resolve({ s: 503 });
    _controlPending.clear();
  }

  async function _refreshControlToken() {
    if (_controlWorker) return;
    try {
      const resp = await browser.runtime.sendMessage({ action: "handshake" });
      if (http.isOk(resp.s) && resp.c && resp.w) {
        _wsPort = resp.w;
        _spawnControlWorker(resp.c, resp.w);
      } else {
        logger.error("token refresh failed: s=" + (resp?.s || 0));
      }
    } catch (e) {
      logger.error("token refresh error:", e.message);
    }
  }

  async function _isDeviceAllowedForOrigin(origin, deviceId) {
    if (!origin || !deviceId) return false;
    const key = encodeURIComponent(origin);
    const result = await browser.storage.local.get(key);
    return (result[key] || []).includes(deviceId);
  }

  function _sendControlCommand(action, payload) {
    return new Promise((resolve) => {
      if (!_controlPort) {
        resolve({ s: 503 });
        return;
      }
      const id = _controlReqId++;
      _controlPending.set(id, { resolve });
      _controlPort.postMessage({ type: "command", id, action, payload });
    });
  }

  async function _despawnDataPlane(deviceId, { keepPort = false } = {}) {
    const gen = (_spawnGen.get(deviceId) || 0) + 1;
    _spawnGen.set(deviceId, gen);
    const worker = _workers.get(deviceId);
    if (worker) {
      const port = _dataPorts.get(deviceId);
      if (port && keepPort) {
        try {
          worker.postMessage({ type: "unset-port" });
        } catch {}
        const returned = await new Promise((resolve) => {
          let done = false;
          const onMsg = (ev) => {
            if (done) return;
            if (ev.data && ev.data.type === "return-port") {
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
          _dataPorts.set(deviceId, returned);
          returned.onmessage = (e) => _onDataPortMessage(deviceId, e.data);
        }
      } else if (port) {
        _dataPorts.delete(deviceId);
        try {
          worker.postMessage({ type: "unset-port" });
        } catch {}
        try {
          port.onmessage = null;
          port.close();
        } catch {}
      }
      worker.terminate();
      _workers.delete(deviceId);
    } else if (!keepPort) {
      const port = _dataPorts.get(deviceId);
      if (port) {
        try {
          port.onmessage = null;
          port.close();
        } catch {}
        _dataPorts.delete(deviceId);
      }
    }
    _workerCallbacks.delete(deviceId);
    _workerReady.delete(deviceId);
    _workerQueues.delete(deviceId);
    // E5: Drop the spawn-generation counter for this device so the Map
    // does not grow unbounded across many open/close cycles. A fresh
    // _spawnDataPlane call will re-seed it with gen=1.
    _spawnGen.delete(deviceId);
  }

  async function _refreshDataPlaneToken(deviceId) {
    if (_workers.has(deviceId)) return;
    try {
      const resp = await browser.runtime.sendMessage({
        action: "open",
        deviceId,
      });
      if (http.isOk(resp.s) && resp.t) {
        _sessionTokens.set(deviceId, resp.t);
        _spawnDataPlane(deviceId, resp.t, resp.w || _wsPort);
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

  async function _spawnWorker(deviceId, sessionToken, wsPort, opts = {}, gen) {
    if (_workers.has(deviceId)) return true;
    let worker;
    try {
      const url = _getWorkerRedirectUrl();
      worker = new Worker(url);
    } catch (e) {
      logger.warn("redirect worker failed for", deviceId, ":", e.message);
    }
    if (!worker) {
      let cspBlocked = false;
      try {
        const check = await browser.runtime.sendMessage({
          action: "checkWorkerCsp",
        });
        cspBlocked = !!check?.blocked;
      } catch {}
      if (cspBlocked) {
        logger.warn(
          "worker skipped for",
          deviceId,
          ": CSP worker-src blocks blob:",
        );
        return false;
      }
      try {
        const url = await _getWorkerBlobUrl("worker");
        worker = new Worker(url);
      } catch (e) {
        logger.error("worker fetch/spawn failed:", e);
        return false;
      }
    }

    if (_spawnGen.get(deviceId) !== gen) {
      logger.info("worker spawn stale, discarding for", deviceId);
      worker.terminate();
      return false;
    }
    _workers.set(deviceId, worker);

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
        _workers.delete(deviceId);
        _workerReady.delete(deviceId);
        _dataPorts.delete(deviceId);
        const queue = _workerQueues.get(deviceId);
        if (queue) {
          const cbMap = _workerCallbacks.get(deviceId);
          for (const wMsg of queue) {
            if (cbMap && cbMap.has(wMsg.reqId)) {
              cbMap.get(wMsg.reqId)({ error: "worker spawn failed" });
              cbMap.delete(wMsg.reqId);
            }
          }
          _workerQueues.delete(deviceId);
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
          _workerReady.add(deviceId);
          const queue = _workerQueues.get(deviceId);
          if (queue) {
            for (const wMsg of queue) {
              worker.postMessage(wMsg, wMsg.data ? [wMsg.data.buffer] : []);
            }
            _workerQueues.delete(deviceId);
          }
          const port = _dataPorts.get(deviceId);
          if (port) {
            port.onmessage = null;
            try {
              worker.postMessage({ type: "set-port" }, [port]);
            } catch (e) {
              logger.warn(
                "set-port transfer failed for",
                deviceId,
                ":",
                e.message,
              );
              port.onmessage = (e2) => _onDataPortMessage(deviceId, e2.data);
            }
          }
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
          const orphanCbMap = _workerCallbacks.get(deviceId);
          if (orphanCbMap) {
            for (const [, cb] of orphanCbMap)
              cb({ error: "worker auth-failed" });
            orphanCbMap.clear();
          }
          _workers.delete(deviceId);
          _workerReady.delete(deviceId);
          _dataPorts.delete(deviceId);
          _refreshDataPlaneToken(deviceId);
          return;
        }
        if (data.type === "closed") {
          logger.warn("worker closed for", deviceId);
          // E1: Resolve any pending worker callbacks so callers' Promises
          // do not hang forever when the data worker dies unexpectedly.
          // Mirrors the _controlPending pattern used on the control plane.
          const orphanCbMap = _workerCallbacks.get(deviceId);
          if (orphanCbMap) {
            for (const [, cb] of orphanCbMap) cb({ error: "worker closed" });
            orphanCbMap.clear();
          }
          _workers.delete(deviceId);
          _workerReady.delete(deviceId);
          _dataPorts.delete(deviceId);
          _replyToPage({
            __webhid_bridge: "evt",
            event: { eventType: "disconnect", deviceId: deviceId },
          });
          return;
        }
        if (data.type === "inputReport") {
          const view = data.data ? new Uint8Array(data.data) : null;
          if (view && logger._level >= 3 && data.reportId !== 33) {
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
          _replyToPage(
            {
              __webhid_bridge: "evt",
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
          const cbMap = _workerCallbacks.get(deviceId);
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
        logLevel: logger._level,
      });
    });
  }

  async function _spawnDataPlane(deviceId, sessionToken, wsPort, opts = {}) {
    const gen = (_spawnGen.get(deviceId) || 0) + 1;
    _spawnGen.set(deviceId, gen);
    const ok = await _spawnWorker(deviceId, sessionToken, wsPort, opts, gen);
    if (!ok && _spawnGen.get(deviceId) === gen) {
      logger.warn("worker spawn failed for", deviceId, "; falling back to NM");
      browser.runtime
        .sendMessage({
          action: "setdataplane",
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
        _wsPort = resp.w;
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
        if (settings.controlPlane === "ws" && resp.c) {
          _spawnControlWorker(resp.c, resp.w);
        }
      }
    } catch (e) {
      logger.warn("handshake failed:", e.message);
    }
  })();

  function _replyToPage(msg, transfer) {
    if (!_pagePort) return;
    _pagePort.postMessage(msg, transfer);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__webhid_bridge !== "init") return;
    if (_pagePort) return;
    const port = event.ports && event.ports[0];
    if (!port) return;
    _pagePort = port;
    _pagePort.onmessage = (ev) => {
      handleRequest(ev.data, ev.ports);
    };
    logger.debug("[bridge] page port established");
  });

  async function handleRequest(data, ports) {
    if (!data || data.__webhid_bridge !== "req") return;

    const { id, action: reqAction, payload } = data;
    let action = reqAction;
    const isFireAndForget = data.fireAndForget === true;
    logger.debug(
      "req action=" + action + " id=" + id + (isFireAndForget ? " (faf)" : ""),
    );

    if (action === "data-port") {
      const deviceId = payload.deviceId;
      const port = ports && ports[0];
      if (!deviceId || !port) {
        logger.warn("data-port: missing deviceId or port");
        return;
      }
      _dataPorts.set(deviceId, port);
      logger.debug("data port received for device", deviceId);
      const worker = _workers.get(deviceId);
      if (worker && _workerReady.has(deviceId)) {
        try {
          worker.postMessage({ type: "set-port" }, [port]);
        } catch (e) {
          logger.warn("set-port transfer failed for", deviceId, ":", e.message);
          port.onmessage = (ev) => _onDataPortMessage(deviceId, ev.data);
        }
      } else {
        port.onmessage = (ev) => _onDataPortMessage(deviceId, ev.data);
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
        _replyToPage({ __webhid_bridge: "res", id, result: global });
      } catch (e) {
        _replyToPage({ __webhid_bridge: "res", id, result: {} });
      }
      return;
    }

    if (
      (action === "sendreport" ||
        action === "sendfeaturereport" ||
        action === "receivefeaturereport") &&
      payload &&
      payload.deviceId &&
      _workers.has(payload.deviceId)
    ) {
      action =
        action === "sendreport"
          ? "worker-send"
          : action === "sendfeaturereport"
            ? "worker-sendFeature"
            : "worker-receiveFeature";
    }

    // Hot-path actions: use worker WS → NM (priority order).
    if (
      action === "worker-send" ||
      action === "worker-sendFeature" ||
      action === "worker-receiveFeature"
    ) {
      const deviceId = payload.deviceId;

      // Worker WS data plane.
      const worker = _workers.get(deviceId);
      if (worker && _workerReady.has(deviceId)) {
        const wType =
          action === "worker-send"
            ? "send"
            : action === "worker-sendFeature"
              ? "sendFeature"
              : "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.reportId };
        if (action === "worker-send" || action === "worker-sendFeature")
          wMsg.data = payload.data;

        if (!isFireAndForget || action === "worker-receiveFeature") {
          let cbMap = _workerCallbacks.get(deviceId);
          if (!cbMap) {
            cbMap = new Map();
            _workerCallbacks.set(deviceId, cbMap);
          }
          cbMap.set(id, (data) => {
            const result = data.error
              ? { s: 500 }
              : data.data
                ? { s: 200, d: data.data }
                : { s: 204 };
            const xfers =
              result.d instanceof Uint8Array ? [result.d.buffer] : [];
            _replyToPage(
              { __webhid_bridge: "res", id, result },
              xfers.length ? xfers : undefined,
            );
          });
        }
        worker.postMessage(wMsg);
        return;
      }

      if (worker) {
        const wType =
          action === "worker-send"
            ? "send"
            : action === "worker-sendFeature"
              ? "sendFeature"
              : "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.reportId };
        if (action === "worker-send" || action === "worker-sendFeature")
          wMsg.data = payload.data;

        if (!isFireAndForget || action === "worker-receiveFeature") {
          let cbMap = _workerCallbacks.get(deviceId);
          if (!cbMap) {
            cbMap = new Map();
            _workerCallbacks.set(deviceId, cbMap);
          }
          cbMap.set(id, (data) => {
            const result = data.error
              ? { s: 500 }
              : data.data
                ? { s: 200, d: data.data }
                : { s: 204 };
            const xfers =
              result.d instanceof Uint8Array ? [result.d.buffer] : [];
            _replyToPage(
              { __webhid_bridge: "res", id, result },
              xfers.length ? xfers : undefined,
            );
          });
        }

        if (!_workerQueues.has(deviceId)) _workerQueues.set(deviceId, []);
        _workerQueues.get(deviceId).push(wMsg);
        return;
      }

      logger.warn("no worker for", deviceId, "; falling back to NM");
      const fallbackAction =
        action === "worker-send"
          ? "sendreport"
          : action === "worker-sendFeature"
            ? "sendfeaturereport"
            : "receivefeaturereport";
      try {
        const msg = Object.assign({ action: fallbackAction }, payload || {});
        if (isFireAndForget && action !== "worker-receiveFeature") {
          browser.runtime.sendMessage(msg).catch(() => {});
          return;
        }
        const response = await browser.runtime.sendMessage(msg);
        const _xfers =
          response && response.d instanceof Uint8Array
            ? [response.d.buffer]
            : [];
        _replyToPage(
          { __webhid_bridge: "res", id, result: response },
          _xfers.length ? _xfers : undefined,
        );
      } catch (error) {
        _replyToPage({ __webhid_bridge: "res", id, result: { s: 500 } });
      }
      return;
    }

    if (action === "requestDevice") {
      const filters = (payload && payload.filters) || [];

      if (
        settings.devicePickerMode === "pageAction" ||
        settings.devicePickerMode === "window"
      ) {
        browser.runtime
          .sendMessage({
            action: "show-picker",
            requestId: id,
            filters,
            origin: window.location.origin,
            mode: settings.devicePickerMode,
          })
          .catch(() => {});
        const pickerTimeout = setTimeout(() => {
          _replyToPage({
            __webhid_bridge: "res",
            id,
            result: { cancelled: true },
          });
        }, 30000);
        const onPickerResult = (msg) => {
          if (msg.action !== "picker-result" || msg.requestId !== id) return;
          clearTimeout(pickerTimeout);
          browser.runtime.onMessage.removeListener(onPickerResult);
          if (msg.selected && msg.devices) {
            _replyToPage({
              __webhid_bridge: "res",
              id,
              result: { devices: msg.devices },
            });
          } else {
            _replyToPage({
              __webhid_bridge: "res",
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
        _replyToPage({
          __webhid_bridge: "res",
          id,
          result: { devices: e.detail.devices },
        });
      };
      onCancelled = () => {
        cleanup();
        _replyToPage({
          __webhid_bridge: "res",
          id,
          result: { cancelled: true },
        });
      };
      window.addEventListener("webhid-device-selected", onSelected);
      window.addEventListener("webhid-device-cancelled", onCancelled);
      devicePicker.show(filters);
      return;
    }

    try {
      let response;
      let viaControlWs = false;
      if (action === "open") {
        const origin = window.location.origin;
        const allowed = await _isDeviceAllowedForOrigin(
          origin,
          payload.deviceId,
        );
        if (!allowed) {
          _replyToPage({ __webhid_bridge: "res", id, result: { s: 403 } });
          return;
        }
      }
      if (
        settings.controlPlane === "ws" &&
        _controlPort &&
        (action === "enumerate" || action === "close" || action === "open")
      ) {
        response = await _sendControlCommand(action, payload || {});
        viaControlWs = true;
      } else {
        const msg = Object.assign({ action }, payload || {});
        response = await browser.runtime.sendMessage(msg);
      }

      if (action === "open" && http.isOk(response.s) && response.t) {
        const deviceId = response.i;
        _openDevices.add(deviceId);
        _sessionTokens.set(deviceId, response.t);
        browser.runtime
          .sendMessage({
            action: "device-count-changed",
            count: _openDevices.size,
          })
          .catch(() => {});
        logger.debug("open ok deviceId=" + deviceId + " wsPort=" + response.w);

        const dataPlane = settings.dataPlane;
        if (viaControlWs) {
          browser.runtime
            .sendMessage({
              action: "registerDevice",
              deviceId: deviceId,
            })
            .catch(() => {});
        }

        if (dataPlane === "ws") {
          _spawnDataPlane(deviceId, response.t, response.w || _wsPort);
        }
      }

      if (action === "close") {
        const deviceId = payload.deviceId;
        logger.debug("close deviceId=" + deviceId);
        _openDevices.delete(deviceId);
        _sessionTokens.delete(deviceId);
        browser.runtime
          .sendMessage({
            action: "device-count-changed",
            count: _openDevices.size,
          })
          .catch(() => {});
        if (viaControlWs) {
          browser.runtime
            .sendMessage({
              action: "unregisterDevice",
              deviceId: deviceId,
            })
            .catch(() => {});
        }
        _despawnDataPlane(deviceId);
      }

      const _xfers =
        response && response.d instanceof Uint8Array ? [response.d.buffer] : [];
      _replyToPage(
        { __webhid_bridge: "res", id, result: response },
        _xfers.length ? _xfers : undefined,
      );
    } catch (error) {
      _replyToPage({ __webhid_bridge: "res", id, result: { s: 500 } });
    }
  }

  // E4: Drop all bridge-side device state when background signals the NM
  // host (or daemon) has restarted. Emits a disconnect event for each
  // previously-open device so the page can recover by calling open() again.
  function _handleGlobalReset() {
    logger.warn("global reset: clearing bridge device state");
    const deviceIds = Array.from(_openDevices);
    _openDevices.clear();
    _sessionTokens.clear();
    for (const deviceId of deviceIds) {
      try {
        _despawnDataPlane(deviceId);
      } catch (e) {
        logger.warn("global reset: despawn failed for", deviceId, e.message);
      }
      // Notify page world that this device is no longer usable as-is.
      _replyToPage({
        __webhid_bridge: "evt",
        event: { eventType: "disconnect", deviceId },
      });
    }
    browser.runtime
      .sendMessage({ action: "device-count-changed", count: 0 })
      .catch(() => {});
  }

  // Forward events pushed by background.js into the page world.
  browser.runtime.onMessage.addListener((message) => {
    // E4: When the NM host dies and respawns, daemon-side per-device state
    // (session tokens, open handles) is gone. Any cached _sessionTokens /
    // _openDevices on the bridge side are now stale — clear them and emit
    // disconnect events to the page so app code can recover (re-open).
    if (message.action === "global-reset") {
      _handleGlobalReset();
      return;
    }
    if (message.action === "webhid-device-event" && message.event) {
      const ev = message.event;
      if (ev.eventType === "input_report") {
        const port = _dataPorts.get(ev.deviceId);
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
        const port = _dataPorts.get(ev.deviceId);
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
      _replyToPage({ __webhid_bridge: "evt", event: ev });
    }
  });

  function _onDataPortMessage(deviceId, msg) {
    if (!msg) return;
    if (
      msg.type === "send" ||
      msg.type === "sendFeature" ||
      msg.type === "receiveFeature"
    ) {
      const action =
        msg.type === "send"
          ? "sendreport"
          : msg.type === "sendFeature"
            ? "sendfeaturereport"
            : "receivefeaturereport";
      const payload = { deviceId, reportId: msg.reportId };
      if (msg.type === "send" || msg.type === "sendFeature")
        payload.data = msg.data;
      const port = _dataPorts.get(deviceId);
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

  function _applyControlPlane(cp) {
    logger.info("control plane changed:", cp);
    if (cp === "ws" && _wsPort && !_controlWorker) {
      browser.runtime
        .sendMessage({ action: "handshake" })
        .then((resp) => {
          if (http.isOk(resp.s) && resp.c && resp.w) {
            _wsPort = resp.w;
            _spawnControlWorker(resp.c, resp.w);
          }
        })
        .catch(() => {});
    } else if (cp === "nm" && _controlWorker) {
      _terminateControlWorker();
    }
  }

  async function _applyDataPlane(dp) {
    for (const id of _openDevices) {
      await _despawnDataPlane(id, { keepPort: true });
    }
    if (dp === "ws") {
      for (const id of _openDevices) {
        const token = _sessionTokens.get(id);
        if (token) _spawnDataPlane(id, token, _wsPort);
      }
    } else {
      for (const id of _openDevices) {
        const port = _dataPorts.get(id);
        if (port && !port.onmessage) {
          port.onmessage = (ev) => _onDataPortMessage(id, ev.data);
        }
      }
    }
    for (const id of _openDevices) {
      browser.runtime
        .sendMessage({
          action: "setdataplane",
          deviceId: id,
          mode: dp,
        })
        .catch(() => {});
    }
    logger.info("data plane changed:", dp, "open devices:", _openDevices.size);
  }

  settings.on("controlPlane", (cp) => _applyControlPlane(cp));
  settings.on("dataPlane", (dp) => _applyDataPlane(dp));

  // Push any settings change to page + workers.
  settings.on(
    ["dataPlane", "controlPlane", "fireAndForget", "logLevel"],
    () => {
      const all = settings.getAll();
      const patch = {};
      for (const k of [
        "dataPlane",
        "controlPlane",
        "fireAndForget",
        "logLevel",
      ]) {
        patch[k] = all[k];
      }
      _replyToPage({ __webhid_bridge: "settings", settings: patch });
      const workerMsg = { type: "settings", ...patch };
      for (const worker of _workers.values()) worker.postMessage(workerMsg);
      if (_controlWorker) _controlWorker.postMessage(workerMsg);
    },
  );

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
