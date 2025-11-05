(() => {
  class HIDDevice extends EventTarget {
    constructor() {
    }
  }

  class HIDInputReportEvent extends Event {
    constructor(data) {
      super("inputreport");
      this.data = data;
    }
  }

  class HIDConnectionEvent extends Event {
    constructor(type, device) {
      super(type);
      this.device = device;
    }
  }

  class HID extends EventTarget {
    #onconnect;
    #ondisconnect;

    constructor() {
      this.#onconnect = function (event) { };
      this.#ondisconnect = function (event) { };
    }

    getDevices() {
      console.debug("getDevices");
      return Promise.resolve([]);
    }

    requestDevice(options) {
      console.debug(`requestDevice(${JSON.stringify(options)})`);
      return Promise.resolve([]);
    }

    get onconnect() {
      return this.#onconnect;
    }

    set onconnect(value) {
      this.removeEventListener("connect", this.#onconnect);
      this.#onconnect = value;
      this.addEventListener("connect", this.#onconnect);
    }

    get ondisconnect() {
      return this.#ondisconnect;
    }

    set ondisconnect(value) {
      this.removeEventListener("disconnect", this.#ondisconnect);
      this.#ondisconnect = value;
      this.addEventListener("disconnect", this.#ondisconnect);
    }
  }

  window.HIDDevice = HIDDevice;
  window.HIDCollectionInfo = HIDCollectionInfo;
  window.HIDInputReportEvent = HIDInputReportEvent;
  window.HIDConnectionEvent = HIDConnectionEvent;
  window.HID = HID;
  navigator.hid = new HID();
})();
