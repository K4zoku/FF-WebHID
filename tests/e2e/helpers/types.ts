export interface CollectionInfo {
  usagePage: number;
  usage: number;
  type: number;
}

export interface DeviceInfo {
  index: number;
  deviceId: string;
  vendorId: number;
  productId: number;
  productName: string;
  collections: CollectionInfo[];
}

export interface InputReportEvent {
  reportId: number;
  data: number[];
  device: {
    vendorId: number;
    productId: number;
  };
}

export interface WebHidTestAPI {
  isPolyfillLoaded: () => Promise<boolean>;
  getDevices: () => Promise<DeviceInfo[]>;
  requestDevice: (filters?: any[]) => Promise<DeviceInfo[]>;
  deviceInfo: (index: number) => Promise<DeviceInfo>;
  open: (index: number) => Promise<void>;
  close: (index: number) => Promise<void>;
  sendReport: (index: number, reportId: number, data: number[]) => Promise<void>;
  onInputReport: (index: number) => Promise<InputReportEvent>;
}
