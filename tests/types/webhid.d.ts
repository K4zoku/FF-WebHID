// WebHID API — spec: https://wicg.github.io/webhid/
// Declares the global API surface exposed by the FF-WebHID polyfill.

// --- §13 HIDUnitSystem enum ---
type HIDUnitSystem =
  | "none"
  | "si-linear"
  | "si-rotation"
  | "english-linear"
  | "english-rotation"
  | "vendor-defined"
  | "reserved";

// --- §10 HIDCollectionInfo dictionary ---
interface HIDCollectionInfo {
  usagePage: number;
  usage: number;
  type: number;
  children: HIDCollectionInfo[];
  inputReports: HIDReportInfo[];
  outputReports: HIDReportInfo[];
  featureReports: HIDReportInfo[];
}

// --- §11 HIDReportInfo dictionary ---
interface HIDReportInfo {
  reportId: number;
  items: HIDReportItem[];
}

// --- §12 HIDReportItem dictionary ---
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

// --- §6.2.1 HIDDeviceRequestOptions dictionary ---
interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
  exclusionFilters?: HIDDeviceFilter[];
}

// --- §6.2.2 HIDDeviceFilter dictionary ---
interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

// --- §8.1 HIDConnectionEventInit dictionary ---
interface HIDConnectionEventInit extends EventInit {
  device: HIDDevice;
}

// --- §9.1 HIDInputReportEventInit dictionary ---
interface HIDInputReportEventInit extends EventInit {
  device: HIDDevice;
  reportId: number;
  data: DataView;
}

// --- §6 HID interface ---
interface HID extends EventTarget {
  onconnect: ((this: HID, ev: HIDConnectionEvent) => void) | null;
  ondisconnect: ((this: HID, ev: HIDConnectionEvent) => void) | null;
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
}

declare var HID: {
  prototype: HID;
  new (): never;
};

// --- §7 HIDDevice interface ---
interface HIDDevice extends EventTarget {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: HIDCollectionInfo[];
  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => void) | null;
  open(): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

declare var HIDDevice: {
  prototype: HIDDevice;
  new (): never;
};

// --- §8 HIDConnectionEvent ---
interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

declare var HIDConnectionEvent: {
  prototype: HIDConnectionEvent;
  new (type: string, eventInitDict: HIDConnectionEventInit): HIDConnectionEvent;
};

// --- §9 HIDInputReportEvent ---
interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

declare var HIDInputReportEvent: {
  prototype: HIDInputReportEvent;
  new (type: string, eventInitDict: HIDInputReportEventInit): HIDInputReportEvent;
};

// --- §4 Navigator.hid ---
interface Navigator {
  readonly hid: HID;
}
