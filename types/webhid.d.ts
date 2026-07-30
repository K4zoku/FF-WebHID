// WebHID API — spec: https://wicg.github.io/webhid/

/** @see https://wicg.github.io/webhid/#extensions-to-the-navigator-interface */
interface Navigator {
  readonly hid: HID;
}

/** @see https://wicg.github.io/webhid/#extensions-to-the-workernavigator-interface */
interface WorkerNavigator {
  readonly hid: HID;
}

/** @see https://wicg.github.io/webhid/#hid-interface */
interface HID extends EventTarget {
  onconnect: ((this: HID, ev: HIDConnectionEvent) => void) | null;
  ondisconnect: ((this: HID, ev: HIDConnectionEvent) => void) | null;
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options?: HIDDeviceRequestOptions): Promise<HIDDevice[]>;

  addEventListener(
    type: "connect" | "disconnect",
    listener: (this: HID, ev: HIDConnectionEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener(
    type: "connect" | "disconnect",
    callback: (this: HID, ev: HIDConnectionEvent) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

declare const HID: {
  prototype: HID;
  new (): never;
};

/** @see https://wicg.github.io/webhid/#hiddevicerequestoptions-dictionary */
interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
  /** @see https://wicg.github.io/webhid/#dom-hiddevicerequestoptions-exclusionfilters */
  exclusionFilters?: HIDDeviceFilter[];
}

/** @see https://wicg.github.io/webhid/#hiddevicefilter-dictionary */
interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

/** @see https://wicg.github.io/webhid/#hiddevice-interface */
interface HIDDevice extends EventTarget {
  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => void) | null;

  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];

  open(): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;

  addEventListener(
    type: "inputreport",
    listener: (this: HIDDevice, ev: HIDInputReportEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener(
    type: "inputreport",
    callback: (this: HIDDevice, ev: HIDInputReportEvent) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

declare const HIDDevice: {
  prototype: HIDDevice;
  new (): never;
};

/** @see https://wicg.github.io/webhid/#hidconnectionevent-interface */
interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

declare const HIDConnectionEvent: {
  prototype: HIDConnectionEvent;
  new (type: string, eventInitDict: HIDConnectionEventInit): HIDConnectionEvent;
};

/** @see https://wicg.github.io/webhid/#hidconnectioneventinit-dictionary */
interface HIDConnectionEventInit extends EventInit {
  device: HIDDevice;
}

/** @see https://wicg.github.io/webhid/#hidinputreportevent-interface */
interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

declare const HIDInputReportEvent: {
  prototype: HIDInputReportEvent;
  new (type: string, eventInitDict: HIDInputReportEventInit): HIDInputReportEvent;
};

/** @see https://wicg.github.io/webhid/#hidinputreporteventinit-dictionary */
interface HIDInputReportEventInit extends EventInit {
  device: HIDDevice;
  reportId: number;
  data: DataView;
}

/** @see https://wicg.github.io/webhid/#hidcollectioninfo-dictionary */
interface HIDCollectionInfo {
  usagePage: number;
  usage: number;
  type: number;
  children: HIDCollectionInfo[];
  inputReports: HIDReportInfo[];
  outputReports: HIDReportInfo[];
  featureReports: HIDReportInfo[];
}

/** @see https://wicg.github.io/webhid/#hidreportinfo-dictionary */
interface HIDReportInfo {
  reportId: number;
  items: HIDReportItem[];
}

/** @see https://wicg.github.io/webhid/#hidreportitem-dictionary */
interface HIDReportItem {
  isAbsolute: boolean;
  isArray: boolean;
  isBufferedBytes: boolean;
  isConstant: boolean;
  isLinear: boolean;
  isRange: boolean;
  isVolatile: boolean;
  hasNull: boolean;
  hasPreferredState: boolean;
  wrap: boolean;
  usages?: number[];
  usageMinimum?: number;
  usageMaximum?: number;
  reportSize: number;
  reportCount: number;
  unitExponent: number;
  unitSystem: HIDUnitSystem;
  unitFactorLengthExponent: number;
  unitFactorMassExponent: number;
  unitFactorTimeExponent: number;
  unitFactorTemperatureExponent: number;
  unitFactorCurrentExponent: number;
  unitFactorLuminousIntensityExponent: number;
  logicalMinimum: number;
  logicalMaximum: number;
  physicalMinimum: number;
  physicalMaximum: number;
  strings: string[];
}

/** @see https://wicg.github.io/webhid/#hidunitsystem-enum */
type HIDUnitSystem =
  | "none"
  | "si-linear"
  | "si-rotation"
  | "english-linear"
  | "english-rotation"
  | "vendor-defined"
  | "reserved";
