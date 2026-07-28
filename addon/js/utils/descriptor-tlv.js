(function () {
  const webhid = globalThis.webhid;

  const TAG_COLLECTION = 0x01;
  const TAG_INPUT_REPORT = 0x02;
  const TAG_OUTPUT_REPORT = 0x03;
  const TAG_FEATURE_REPORT = 0x04;
  const TAG_FIELD = 0x05;

  const UNIT_SYSTEMS = [
    "none",
    "si-linear",
    "si-rotation",
    "english-linear",
    "english-rotation",
    "vendor-defined",
    "reserved",
  ];

  function decodeCollectionsTlv(b64) {
    if (!b64 || typeof b64 !== "string") return [];
    const bin = Uint8Array.fromBase64(b64);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    let off = 0;

    function readVarint() {
      let result = 0,
        shift = 0,
        byte;
      do {
        byte = dv.getUint8(off++);
        result |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      return result >>> 0;
    }

    function readNode() {
      const tag = dv.getUint8(off++);
      const len = readVarint();
      const end = off + len;
      let node;
      switch (tag) {
        case TAG_COLLECTION:
          node = readCollection(end);
          break;
        case TAG_INPUT_REPORT:
        case TAG_OUTPUT_REPORT:
        case TAG_FEATURE_REPORT:
          node = readReport(end);
          break;
        case TAG_FIELD:
          node = readField();
          break;
        default:
          node = null;
      }
      off = end;
      return { tag, node };
    }

    function readCollection(end) {
      const presence = dv.getUint8(off++);
      const usagePage =
        presence & 1 ? ((off += 2), dv.getUint16(off - 2, true)) : undefined;
      const usage =
        presence & 2 ? ((off += 2), dv.getUint16(off - 2, true)) : undefined;
      const type = dv.getUint8(off++);
      const children = [];
      const inputReports = [];
      const outputReports = [];
      const featureReports = [];
      while (off < end) {
        const { tag, node } = readNode();
        if (node === null) continue;
        if (tag === TAG_COLLECTION) children.push(node);
        else if (tag === TAG_INPUT_REPORT) inputReports.push(node);
        else if (tag === TAG_OUTPUT_REPORT) outputReports.push(node);
        else if (tag === TAG_FEATURE_REPORT) featureReports.push(node);
      }
      return {
        type,
        usagePage,
        usage,
        children,
        inputReports,
        outputReports,
        featureReports,
      };
    }

    function readReport(end) {
      const reportId = dv.getUint8(off++);
      const items = [];
      while (off < end) {
        const { node } = readNode();
        if (node) items.push(node);
      }
      return { reportId, items };
    }

    function readField() {
      const flags = dv.getUint16(off, true);
      off += 2;
      const reportSize = readVarint();
      const reportCount = readVarint();
      const logicalMinimum = dv.getInt32(off, true);
      off += 4;
      const logicalMaximum = dv.getInt32(off, true);
      off += 4;
      const physicalMinimum = dv.getInt32(off, true);
      off += 4;
      const physicalMaximum = dv.getInt32(off, true);
      off += 4;
      const unitExponent = dv.getInt8(off++);
      const unitSystem = UNIT_SYSTEMS[dv.getUint8(off++)] || "reserved";
      const unitFactorLengthExponent = dv.getInt8(off++);
      const unitFactorMassExponent = dv.getInt8(off++);
      const unitFactorTimeExponent = dv.getInt8(off++);
      const unitFactorTemperatureExponent = dv.getInt8(off++);
      const unitFactorCurrentExponent = dv.getInt8(off++);
      const unitFactorLuminousIntensityExponent = dv.getInt8(off++);
      const isRange = !!(flags & 4);
      let usages, usageMinimum, usageMaximum;
      if (isRange) {
        usageMinimum = dv.getUint32(off, true);
        off += 4;
        usageMaximum = dv.getUint32(off, true);
        off += 4;
      } else {
        const count = readVarint();
        usages = [];
        for (let i = 0; i < count; i++) {
          usages.push(dv.getUint32(off, true));
          off += 4;
        }
      }
      const stringsCount = readVarint();
      const strings = [];
      for (let i = 0; i < stringsCount; i++) {
        const byteLen = readVarint();
        strings.push(
          new TextDecoder().decode(bin.subarray(off, off + byteLen)),
        );
        off += byteLen;
      }
      return {
        isAbsolute: !!(flags & 1),
        isArray: !!(flags & 2),
        isRange,
        isConstant: !!(flags & 8),
        isLinear: !!(flags & 16),
        isVolatile: !!(flags & 32),
        isBufferedBytes: !!(flags & 64),
        hasNull: !!(flags & 128),
        hasPreferredState: !!(flags & 256),
        wrap: !!(flags & 512),
        reportSize,
        reportCount,
        logicalMinimum,
        logicalMaximum,
        physicalMinimum,
        physicalMaximum,
        unitExponent,
        unitSystem,
        unitFactorLengthExponent,
        unitFactorMassExponent,
        unitFactorTimeExponent,
        unitFactorTemperatureExponent,
        unitFactorCurrentExponent,
        unitFactorLuminousIntensityExponent,
        usages,
        usageMinimum,
        usageMaximum,
        strings,
      };
    }

    const roots = [];
    while (off < bin.byteLength) {
      const { tag, node } = readNode();
      if (tag === TAG_COLLECTION && node) roots.push(node);
    }
    return roots;
  }

  webhid.export("decodeCollectionsTlv", decodeCollectionsTlv);
})();
