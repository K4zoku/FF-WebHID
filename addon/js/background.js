(function () {
  const logger = __webhid.import("logger");
  const http = __webhid.import("http");
  const createSettingsStore = __webhid.import("createSettingsStore");
  const GLOBAL_DEFAULTS = __webhid.import("GLOBAL_DEFAULTS");
  const fetchResource = __webhid.import("fetchResource");
  logger.initLogger("bg");

  let _deviceCache = [];
  const _pendingPicker = new Map();

  async function _saveDeviceInfo(device) {
    if (!device || !device.deviceId) return;
    try {
      await browser.storage.local.set({
        [`deviceInfo:${device.deviceId}`]: device,
      });
    } catch {}
  }

  async function _saveDeviceInfoBatch(devices) {
    if (!devices || !devices.length) return;
    const entries = {};
    for (const d of devices) {
      if (d && d.deviceId) entries[`deviceInfo:${d.deviceId}`] = d;
    }
    try {
      await browser.storage.local.set(entries);
    } catch {}
  }

  async function _getDeviceInfo(deviceId) {
    if (!deviceId) return null;
    const live = _deviceCache.find((d) => d.deviceId === deviceId);
    if (live) return live;
    try {
      const result = await browser.storage.local.get(`deviceInfo:${deviceId}`);
      return result[`deviceInfo:${deviceId}`] || null;
    } catch {
      return null;
    }
  }

  async function _removeDeviceInfo(deviceId) {
    if (!deviceId) return;
    try {
      await browser.storage.local.remove(`deviceInfo:${deviceId}`);
    } catch {}
  }

  const _deviceTabMap = new Map();
  const _cspWorkerBlocked = new Map();

  function _parseWorkerAllowed(cspValue) {
    if (!cspValue) return true;
    const directives = {};
    for (const part of cspValue.split(";")) {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length > 1)
        directives[tokens[0].toLowerCase()] = tokens
          .slice(1)
          .map((s) => s.toLowerCase());
    }
    const src =
      directives["worker-src"] ||
      directives["child-src"] ||
      directives["default-src"] ||
      null;
    if (!src) return true;
    return src.some(
      (s) =>
        s === "blob:" ||
        s === "*" ||
        s === "moz-extension:" ||
        s.startsWith("moz-extension://"),
    );
  }

  if (browser.webRequest?.onHeadersReceived) {
    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (details.tabId < 0) return;
        const cspHeader = details.responseHeaders?.find(
          (h) => h.name.toLowerCase() === "content-security-policy",
        );
        if (!cspHeader) return;
        _cspWorkerBlocked.set(
          details.tabId,
          !_parseWorkerAllowed(cspHeader.value),
        );
      },
      { urls: ["<all_urls>"], types: ["main_frame"] },
      ["responseHeaders"],
    );
  }

  let _workerBundle = null;
  let _workerBundlePromise = null;
  let _armedFilter = null;
  let _armedFilterTimer = null;
  let _filteredRequestId = null;

  async function _ensureWorkerBundle() {
    if (_workerBundle) return _workerBundle;
    if (_workerBundlePromise) return _workerBundlePromise;
    const files = [
      "js/utils/bootstrap.js",
      "js/utils/logger.js",
      "js/utils/settings.js",
      "js/utils/websocket.js",
      "js/worker.js",
    ];
    _workerBundlePromise = (async () => {
      const texts = await Promise.all(files.map((f) =>
        fetch(browser.runtime.getURL(f)).then((r) => {
          if (!r.ok) throw new Error("fetch " + f + " failed: " + r.status);
          return r.text();
        }),
      ));
      _workerBundle = texts.join("\n");
      return _workerBundle;
    })();
    return _workerBundlePromise;
  }
  _ensureWorkerBundle();

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!_armedFilter ||
          details.url !== _armedFilter.url ||
          details.tabId !== _armedFilter.tabId) return;
      _filteredRequestId = details.requestId;
      _armedFilter = null;
      if (_armedFilterTimer) {
        clearTimeout(_armedFilterTimer);
        _armedFilterTimer = null;
      }
      logger.info("StreamFilter: replacing body for", details.url);
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const enc = new TextEncoder();
      filter.onstart = () => {
        if (_workerBundle) {
          filter.write(enc.encode(_workerBundle));
        } else {
          filter.write(enc.encode(
            "self.postMessage({ type: 'error', error: 'worker bundle not ready' });"
          ));
        }
        filter.close();
      };
      return {};
    },
    { urls: ["<all_urls>"], types: ["script", "other", "xmlhttprequest"] },
    ["blocking"],
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.requestId !== _filteredRequestId) return;
      _filteredRequestId = null;
      logger.info("StreamFilter: fixing headers for", details.url);
      const headers = details.responseHeaders.filter(
        (h) => !/^(content-security-policy|content-type|content-length|content-disposition|x-content-type-options)$/i.test(h.name),
      );
      headers.push({ name: "Content-Type", value: "application/javascript" });
      return { responseHeaders: headers };
    },
    { urls: ["<all_urls>"], types: ["script", "other", "xmlhttprequest"] },
    ["blocking", "responseHeaders"],
  );

  function registerDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return;
    let tabs = _deviceTabMap.get(deviceId);
    if (!tabs) {
      tabs = new Set();
      _deviceTabMap.set(deviceId, tabs);
    }
    tabs.add(tabId);
    logger.debug("register device " + deviceId + " tab " + tabId);
  }

  function unregisterDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return;
    const tabs = _deviceTabMap.get(deviceId);
    if (!tabs) return;
    tabs.delete(tabId);
    if (tabs.size === 0) _deviceTabMap.delete(deviceId);
  }

  function isTabAuthorizedForDevice(tabId, deviceId) {
    const tabs = _deviceTabMap.get(deviceId);
    return !!tabs && tabs.has(tabId);
  }

  function purgeTab(tabId) {
    if (tabId == null) return;
    for (const [deviceId, tabs] of _deviceTabMap) {
      if (tabs.delete(tabId) && tabs.size === 0) {
        _deviceTabMap.delete(deviceId);
        NativeMessaging.closeDevice(deviceId).catch(() => {});
      }
    }
    _cspWorkerBlocked.delete(tabId);
  }

  // NM event codes (must match Rust constants)
  const EVT_HANDSHAKE = 1;
  const EVT_CONNECT = 2;
  const EVT_DISCONNECT = 3;

  // NM action codes (must match Rust constants)
  const ACT = {
    enum: 1,
    open: 2,
    close: 3,
    sr: 4,
    rfr: 5,
    sfr: 6,
    sdp: 7,
    hs: 8,
  };

  // Packed binary message types (must match Rust constants)
  const PKG_INPUT_REPORT = 0x01;
  const PKG_SEND_REPORT = 0x02;
  const PKG_SEND_FEATURE_REPORT = 0x04;

  function tabsForEvent(message) {
    const eventType = message.e;
    if (eventType === EVT_HANDSHAKE || !message.i) return null;
    const tabs = _deviceTabMap.get(message.i);
    return tabs && tabs.size > 0 ? [...tabs] : null;
  }

  async function isDeviceAllowedForOrigin(origin, deviceId) {
    if (!origin || !deviceId) return false;
    const key = encodeURIComponent(origin);
    const result = await browser.storage.local.get(key);
    return (result[key] || []).includes(deviceId);
  }

  // E4: Fan out a global-reset message to every content-script bridge
  // currently loaded in any tab. The bridge clears its _sessionTokens /
  // _openDevices maps and emits disconnect events to the page. Used when
  // the NM host / daemon disappears so callers stop using stale tokens.
  function _broadcastGlobalReset() {
    browser.tabs
      .query({})
      .then((tabs) => {
        for (const tab of tabs) {
          if (!tab.url) continue;
          try {
            new URL(tab.url);
          } catch {
            continue;
          }
          browser.tabs
            .sendMessage(tab.id, { action: "global-reset" })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  const NM_HOST_FORWARDER = "webhid.forwarder_nm_host";
  const NM_HOST_DAEMON = "webhid.daemon_nm_host";

  const settings = createSettingsStore(GLOBAL_DEFAULTS);
  function _nmHostName() {
    return settings.daemonAsNmHost ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
  }

  async function loadNmHostSetting() {
    const global = await browser.storage.local.get(GLOBAL_DEFAULTS);
    const stored = await browser.storage.local.get("daemonAsNmHost");
    if (stored.daemonAsNmHost === undefined) {
      const platformInfo = await browser.runtime.getPlatformInfo();
      if (platformInfo.os === "win") {
        global.daemonAsNmHost = true;
        await browser.storage.local.set({ daemonAsNmHost: true });
      }
    }
    settings.set(global);
    logger.info("NM host:", _nmHostName());
  }

  settings.on("daemonAsNmHost", () => {
    logger.info("NM host changed:", _nmHostName());
    NativeMessaging.reconnectWithNewHost();
  });

  function buildPackedSend(msgType, reqId, deviceId, reportId, data) {
    const buf = new Uint8Array(12 + data.length);
    const dv = new DataView(buf.buffer);
    buf[0] = msgType;
    dv.setUint32(1, reqId, true);
    dv.setUint32(5, deviceId, true);
    buf[9] = reportId;
    dv.setUint16(10, data.length, true);
    buf.set(data, 12);
    return buf;
  }

  const NativeMessaging = {
    port: null,
    _nextId: 1,
    _pending: new Map(),
    _reconnectTimer: null,
    _reconnectDelay: 1000,

    connect() {
      if (this.port) return Promise.resolve();
      logger.debug("connecting to " + _nmHostName() + "...");
      try {
        this.port = browser.runtime.connectNative(_nmHostName());
        this._reconnectDelay = 1000;
        logger.debug("connected");

        this.port.onMessage.addListener((message) => {
          if (
            message.E !== undefined &&
            message.s !== undefined &&
            message.n === undefined
          ) {
            logger.error("host error: " + message.E);
            for (const [, p] of this._pending) p.resolve(message);
            this._pending.clear();
            return;
          }
          if (
            message.d !== undefined &&
            message.n === undefined &&
            message.e === undefined
          ) {
            this.onPackedData(message.d);
            return;
          }
          if (message.e !== undefined) {
            this.onControlEvent(message);
            return;
          }
          if (message.n !== undefined) {
            const p = this._pending.get(message.n);
            if (p) {
              this._pending.delete(message.n);
              p.resolve(message);
              return;
            }
          }
          logger.warn("unmatched:", message);
        });

        this.port.onDisconnect.addListener(() => {
          logger.warn(
            "disconnected; will retry in " +
              this._reconnectDelay +
              "ms. " +
              "If persistent: check daemon status (systemctl status webhid-daemon), " +
              "group membership (groups), and NM host manifest.",
          );
          this.port = null;
          for (const [id, p] of this._pending) p.resolve({ s: 503 });
          this._pending.clear();
          // E4: Broadcast a global-reset to every content-script bridge so
          // they drop stale _sessionTokens / _openDevices state. Daemon
          // restart invalidates every session token; without this, the
          // bridge would happily keep routing sendReport using tokens the
          // daemon no longer recognizes, leaving pages in a half-broken
          // state until they explicitly close + reopen.
          _broadcastGlobalReset();
          this._scheduleReconnect();
        });

        return Promise.resolve();
      } catch (error) {
        logger.error("connect failed:", error);
        this._scheduleReconnect();
        return Promise.reject(error);
      }
    },

    reconnectWithNewHost() {
      if (this.port) {
        try {
          this.port.disconnect();
        } catch {}
        this.port = null;
      }
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._reconnectDelay = 1000;
      this.connect().catch(() => {});
    },

    _scheduleReconnect() {
      if (this._reconnectTimer) return;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        logger.debug("reconnecting...");
        this.connect().catch(() => {});
      }, this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
    },

    sendRequest(request) {
      return new Promise((resolve, reject) => {
        if (!this.port) {
          this.connect().catch(() => {});
          reject(new Error("NM disconnected, reconnecting; please retry"));
          return;
        }
        const id = this._nextId++;
        this._pending.set(id, { resolve, reject });
        logger.debug("sendRequest a=" + (request.a || "packed") + " n=" + id);
        try {
          this.port.postMessage({ ...request, n: id });
        } catch (e) {
          this._pending.delete(id);
          reject(e);
        }
      });
    },

    sendPacked(buildPackedFn) {
      return new Promise((resolve, reject) => {
        if (!this.port) {
          this.connect().catch(() => {});
          reject(new Error("NM disconnected, reconnecting; please retry"));
          return;
        }
        const id = this._nextId++;
        this._pending.set(id, { resolve, reject });
        const packedBuf = buildPackedFn(id);
        logger.debug(
          "sendPacked msgType=0x" + packedBuf[0].toString(16) + " n=" + id,
        );
        try {
          this.port.postMessage({ d: packedBuf.toBase64() });
        } catch (e) {
          this._pending.delete(id);
          reject(e);
        }
      });
    },

    async enumerateDevices() {
      return await this.sendRequest({ a: ACT.enum });
    },
    async openDevice(deviceId) {
      return await this.sendRequest({ a: ACT.open, i: deviceId });
    },
    async closeDevice(deviceId) {
      return await this.sendRequest({ a: ACT.close, i: deviceId });
    },
    async handshake() {
      return await this.sendRequest({ a: ACT.hs });
    },
    async sendReport(deviceId, reportId, data) {
      return await this.sendPacked((reqId) =>
        buildPackedSend(PKG_SEND_REPORT, reqId, deviceId, reportId, data),
      );
    },
    async receiveFeatureReport(deviceId, reportId) {
      const resp = await this.sendRequest({
        a: ACT.rfr,
        i: deviceId,
        r: reportId,
      });
      if (resp && typeof resp.d === "string") {
        resp.d = Uint8Array.fromBase64(resp.d);
      }
      return resp;
    },
    async sendFeatureReport(deviceId, reportId, data) {
      return await this.sendPacked((reqId) =>
        buildPackedSend(
          PKG_SEND_FEATURE_REPORT,
          reqId,
          deviceId,
          reportId,
          data,
        ),
      );
    },

    onPackedData(b64) {
      // E8: Wrap the whole handler in try/catch. A malformed b64 string or
      // truncated payload used to throw out of the NM onMessage listener,
      // which kills the NM connection and forces a reconnect. Now we just
      // log and drop the bad frame, keeping the NM stream alive.
      let bin;
      try {
        bin = Uint8Array.fromBase64(b64);
      } catch (e) {
        logger.warn("onPackedData: bad base64 frame dropped:", e.message);
        return;
      }
      try {
        if (bin.length < 8 || bin[0] !== PKG_INPUT_REPORT) return;
        const deviceId =
          (bin[1] | (bin[2] << 8) | (bin[3] << 16) | (bin[4] << 24)) >>> 0;
        const reportId = bin[5];
        const payloadLen = bin[6] | (bin[7] << 8);
        const payloadEnd = 8 + payloadLen;
        if (payloadEnd > bin.length) return;
        const payload = new Uint8Array(payloadLen);
        payload.set(bin.subarray(8, payloadEnd));

        const event = {
          eventType: "input_report",
          deviceId,
          reportId,
          data: payload,
        };
        const targets = tabsForEvent({ i: deviceId });
        if (!targets) return;
        for (const tabId of targets) {
          browser.tabs
            .sendMessage(tabId, { action: "webhid-device-event", event })
            .catch(() => {});
        }
      } catch (e) {
        logger.warn("onPackedData: malformed frame dropped:", e.message);
      }
    },

    onControlEvent(message) {
      if (message.e === undefined) return;
      if (message.e === EVT_CONNECT || message.e === EVT_DISCONNECT) {
        if (message.v) {
          if (message.e === EVT_CONNECT) {
            if (!_deviceCache.some((d) => d.deviceId === message.v.deviceId))
              _deviceCache.push(message.v);
            _saveDeviceInfo(message.v);
          } else {
            _deviceCache = _deviceCache.filter((d) => d.deviceId !== message.i);
          }
        } else {
          NativeMessaging.enumerateDevices()
            .then((resp) => {
              if (http.isOk(resp.s) && resp.D) _deviceCache = resp.D;
            })
            .catch(() => {});
        }
        const normalized = {
          eventType: message.e === EVT_CONNECT ? "connect" : "disconnect",
          deviceId: message.i,
          device: message.v || null,
        };
        browser.runtime
          .sendMessage({ action: "webhid-device-event", event: normalized })
          .catch(() => {});
        browser.tabs
          .query({})
          .then((tabs) => {
            for (const tab of tabs) {
              if (!tab.url) continue;
              try {
                new URL(tab.url);
              } catch {
                continue;
              }
              browser.tabs
                .sendMessage(tab.id, {
                  action: "webhid-device-event",
                  event: normalized,
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
        return;
      }
      const targets = tabsForEvent(message);
      if (targets) {
        for (const tabId of targets) {
          browser.tabs
            .sendMessage(tabId, {
              action: "webhid-device-event",
              event: message,
            })
            .catch(() => {});
        }
      }
    },
  };

  browser.runtime.onStartup.addListener(() => {
    loadNmHostSetting().then(() => NativeMessaging.connect());
  });
  browser.runtime.onInstalled.addListener(() => {
    loadNmHostSetting().then(() => NativeMessaging.connect());
  });
  loadNmHostSetting().then(() => NativeMessaging.connect());
  browser.tabs.onRemoved.addListener((tabId) => purgeTab(tabId));

  if (browser.action?.onClicked) {
    browser.action.onClicked.addListener(() => {
      browser.runtime.openOptionsPage();
    });
  }

  if (browser.notifications?.onClicked) {
    browser.notifications.onClicked.addListener(() => {
      if (_pendingPicker.size > 0) {
        const [tabId, req] = [..._pendingPicker.entries()][0];
        browser.tabs.update(tabId, { active: true }).catch(() => {});
        browser.pageAction.openPopup?.().catch(() => {});
        browser.notifications.clear("webhid-picker").catch(() => {});
      }
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const patch = {};
    for (const k of Object.keys(GLOBAL_DEFAULTS)) {
      if (changes[k]) patch[k] = changes[k].newValue;
    }
    if (Object.keys(patch).length === 0) return;
    settings.set(patch);
  });

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case "enumerate":
        NativeMessaging.enumerateDevices()
          .then((response) => {
            if (http.isOk(response.s) && response.D) {
              _deviceCache = response.D;
              _saveDeviceInfoBatch(response.D);
            }
            sendResponse(response);
          })
          .catch((e) => sendResponse({ s: 500 }));
        return true;

      case "handshake":
        NativeMessaging.handshake()
          .then(sendResponse)
          .catch((e) => sendResponse({ s: 500 }));
        return true;

      case "open": {
        const tabId = sender.tab?.id;
        const origin = sender.tab?.url ? new URL(sender.tab.url).origin : null;
        isDeviceAllowedForOrigin(origin, request.deviceId).then((allowed) => {
          if (!allowed) {
            sendResponse({ s: 403 });
            return;
          }
          NativeMessaging.openDevice(request.deviceId)
            .then((response) => {
              if (http.isOk(response.s) && response.i)
                registerDeviceTab(response.i, tabId);
              sendResponse(response);
            })
            .catch((e) => sendResponse({ s: 500 }));
        });
        return true;
      }

      case "close": {
        const tabId = sender.tab?.id;
        NativeMessaging.closeDevice(request.deviceId)
          .then((response) => {
            if (http.isOk(response.s))
              unregisterDeviceTab(request.deviceId, tabId);
            sendResponse(response);
          })
          .catch((e) => sendResponse({ s: 500 }));
        return true;
      }

      case "setdataplane":
        if (!isTabAuthorizedForDevice(sender.tab?.id, request.deviceId)) {
          sendResponse({ s: 403 });
          return true;
        }
        NativeMessaging.sendRequest({
          a: ACT.sdp,
          i: request.deviceId,
          m: request.mode,
        })
          .then(sendResponse)
          .catch((e) => sendResponse({ s: 500 }));
        return true;

      case "sendreport":
        if (!isTabAuthorizedForDevice(sender.tab?.id, request.deviceId)) {
          sendResponse({ s: 403 });
          return true;
        }
        logger.debug(
          "sendreport: deviceId=" +
            request.deviceId +
            " reportId=" +
            (request.reportId || 0) +
            " dataLen=" +
            (request.data?.length ?? "undefined") +
            " dataCtor=" +
            (request.data?.constructor?.name ?? "undefined"),
        );
        NativeMessaging.sendReport(
          request.deviceId,
          request.reportId || 0,
          request.data,
        )
          .then((resp) => {
            logger.debug("sendreport resp:", resp);
            sendResponse(resp);
          })
          .catch((e) => {
            logger.error("sendreport error:", e.message);
            sendResponse({ s: 500 });
          });
        return true;

      case "receivefeaturereport":
        if (!isTabAuthorizedForDevice(sender.tab?.id, request.deviceId)) {
          sendResponse({ s: 403 });
          return true;
        }
        NativeMessaging.receiveFeatureReport(request.deviceId, request.reportId)
          .then(sendResponse)
          .catch((e) => sendResponse({ s: 500 }));
        return true;

      case "sendfeaturereport":
        if (!isTabAuthorizedForDevice(sender.tab?.id, request.deviceId)) {
          sendResponse({ s: 403 });
          return true;
        }
        NativeMessaging.sendFeatureReport(
          request.deviceId,
          request.reportId || 0,
          request.data,
        )
          .then(sendResponse)
          .catch((e) => sendResponse({ s: 500 }));
        return true;

      case "getPairedDevices":
        (async () => {
          try {
            const key = encodeURIComponent(request.origin);
            const result = await browser.storage.local.get(key);
            sendResponse({ success: true, hashes: result[key] || [] });
          } catch (e) {
            sendResponse({ success: false, error: e.message, hashes: [] });
          }
        })();
        return true;

      case "pairDevice":
        (async () => {
          try {
            const key = encodeURIComponent(request.origin);
            const result = await browser.storage.local.get(key);
            const hashes = result[key] || [];
            if (!hashes.includes(request.device.deviceId)) {
              hashes.push(request.device.deviceId);
              await browser.storage.local.set({ [key]: hashes });
            }
            sendResponse({ success: true, hashes });
          } catch (e) {
            sendResponse({ success: false, error: e.message, hashes: [] });
          }
        })();
        return true;

      case "unpairDevice":
        (async () => {
          try {
            const origin = new URL(sender.tab?.url || "http://localhost")
              .origin;
            const storageKey = encodeURIComponent(origin);
            const result = await browser.storage.local.get(storageKey);
            let hashes = result[storageKey] || [];
            if (request.deviceId) {
              hashes = hashes.filter((h) => h !== request.deviceId);
              await browser.storage.local.set({ [storageKey]: hashes });
              _removeDeviceInfo(request.deviceId);
            }
            sendResponse({ success: true, hashes });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        })();
        return true;

      case "registerDevice": {
        const tabId = sender.tab?.id;
        if (request.deviceId && tabId != null)
          registerDeviceTab(request.deviceId, tabId);
        sendResponse({ s: 204 });
        return false;
      }

      case "unregisterDevice": {
        const tabId = sender.tab?.id;
        if (request.deviceId && tabId != null)
          unregisterDeviceTab(request.deviceId, tabId);
        sendResponse({ s: 204 });
        return false;
      }

      case "device-count-changed":
        if (browser.action) {
          const tabId = sender.tab?.id;
          if (tabId != null) {
            browser.action.setBadgeText({
              text: request.count > 0 ? String(request.count) : "",
              tabId,
            });
          }
        }
        return false;

      case "getDeviceCache":
        if (_deviceCache.length === 0) {
          NativeMessaging.enumerateDevices()
            .then((response) => {
              if (http.isOk(response.s) && response.D) {
                _deviceCache = response.D;
              }
              _saveDeviceInfoBatch(_deviceCache);
              sendResponse({ devices: _deviceCache });
            })
            .catch(() => sendResponse({ devices: _deviceCache }));
          return true;
        }
        _saveDeviceInfoBatch(_deviceCache);
        sendResponse({ devices: _deviceCache });
        return false;

      case "getDeviceInfo":
        _getDeviceInfo(request.deviceId).then((device) => {
          sendResponse({ device });
        });
        return true;

      case "checkWorkerCsp":
        sendResponse({ blocked: !!_cspWorkerBlocked.get(sender.tab?.id) });
        return false;

      case "armWorkerFilter":
        if (_armedFilterTimer) clearTimeout(_armedFilterTimer);
        _armedFilter = { url: request.url, tabId: sender.tab?.id };
        _armedFilterTimer = setTimeout(() => { _armedFilter = null; }, 5000);
        sendResponse({ ok: true });
        return false;

      case "disarmWorkerFilter":
        _armedFilter = null;
        if (_armedFilterTimer) {
          clearTimeout(_armedFilterTimer);
          _armedFilterTimer = null;
        }
        sendResponse({ ok: true });
        return false;

      case "fetchResource": {
        const path = request.path;
        if (!path || typeof path !== "string" || path.includes("..")) {
          sendResponse({ error: "invalid path" });
          return false;
        }
        fetch(browser.runtime.getURL(path))
          .then((r) => r.text())
          .then((text) => sendResponse({ text }))
          .catch((e) => sendResponse({ error: e.message || String(e) }));
        return true;
      }

      case "show-picker": {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ error: "no tab" });
          return false;
        }
        const req = {
          requestId: request.requestId,
          tabId,
          filters: request.filters || [],
          origin: request.origin,
          mode: request.mode || "pageAction",
        };
        _pendingPicker.set(tabId, req);

        if (req.mode === "window") {
          const screenW = globalThis.screen?.availWidth || 1280;
          const screenH = globalThis.screen?.availHeight || 720;
          const winW = Math.min(380, screenW - 20);
          const winH = Math.min(480, screenH - 80);
          const left = Math.max(0, Math.round((screenW - winW) / 2));
          const top = Math.max(0, Math.round((screenH - winH) / 2));
          browser.windows
            .create({
              type: "popup",
              url: "html/picker.html",
              width: winW,
              height: winH,
              left,
              top,
            })
            .catch(() => {});
        } else {
          browser.pageAction.setIcon({
            tabId,
            path: "icons/gamepad.alert.svg",
          });
          browser.pageAction.setPopup({
            tabId,
            popup: "html/picker.html",
          });
          browser.pageAction.openPopup?.().catch(() => {});
          browser.tabs
            .query({ active: true, currentWindow: true })
            .then((tabs) => {
              const tab = tabs[0];
              if (tab && tab.id !== tabId) {
                browser.notifications.create("webhid-picker", {
                  type: "basic",
                  iconUrl: browser.runtime.getURL("icons/icon.svg"),
                  title: "WebHID",
                  message: `A website (${request.origin}) is requesting a HID device. Click to choose.`,
                });
              }
            })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        return false;
      }

      case "getPendingPicker": {
        sendResponse(
          _pendingPicker.size > 0 ? [..._pendingPicker.values()][0] : null,
        );
        return false;
      }

      case "picker-result": {
        const { requestId, selected, devices } = request;
        let tabId = request.tabId;
        if (tabId == null && _pendingPicker.size > 0) {
          tabId = [..._pendingPicker.keys()][0];
        }
        const req = tabId != null ? _pendingPicker.get(tabId) : null;
        if (tabId != null) _pendingPicker.delete(tabId);
        if (req?.mode === "pageAction") {
          browser.pageAction.setIcon({ tabId, path: "icons/gamepad.svg" });
          browser.pageAction.setPopup({ tabId, popup: "html/popup.html" });
          browser.notifications?.clear("webhid-picker").catch(() => {});
        }
        if (request.windowId != null) {
          browser.windows.remove(request.windowId).catch(() => {});
        }
        if (tabId != null) {
          browser.tabs
            .sendMessage(tabId, {
              action: "picker-result",
              requestId,
              selected,
              devices: selected ? devices : null,
            })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  });
})();
