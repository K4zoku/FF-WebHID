#!/usr/bin/env node

import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'tests', 'fixtures', 'descriptors')
const EDGE_DIR = join(OUT_DIR, 'edge')

function usagePage(p) {
  if (p > 0xff) return Buffer.from([0x06, p & 0xff, (p >> 8) & 0xff])
  return Buffer.from([0x05, p])
}

function usage(u) {
  if (u > 0xff) return Buffer.from([0x0a, u & 0xff, (u >> 8) & 0xff])
  return Buffer.from([0x09, u])
}

function collection(t = 1) {
  return Buffer.from([0xa1, t])
}
function endCollection() {
  return Buffer.from([0xc0])
}
function reportId(r) {
  return Buffer.from([0x85, r])
}
function reportSize(s) {
  return Buffer.from([0x75, s])
}
function reportCount(c) {
  return Buffer.from([0x95, c])
}
function inputData(flags = 0x02) {
  return Buffer.from([0x81, flags])
}
function outputData(flags = 0x02) {
  return Buffer.from([0x91, flags])
}

function logicalMin(v) {
  if (v >= -128 && v <= 127) return Buffer.from([0x15, v & 0xff])
  if (v >= -32768 && v <= 32767) return Buffer.from([0x16, v & 0xff, (v >> 8) & 0xff])
  return Buffer.from([0x17, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff])
}

function logicalMax(v) {
  if (v >= 0 && v <= 255) return Buffer.from([0x25, v & 0xff])
  if (v >= 0 && v <= 65535) return Buffer.from([0x26, v & 0xff, (v >> 8) & 0xff])
  return Buffer.from([0x27, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff])
}

function unitExponent(e) {
  return Buffer.from([0x55, e & 0xff])
}
function unitBytes(b) {
  return Buffer.from([0x65, b.length, ...b])
}

function usageMinimum(u) {
  return u <= 0xff ? Buffer.from([0x18, u]) : Buffer.from([0x19, u & 0xff, (u >> 8) & 0xff])
}

function usageMaximum(u) {
  return u <= 0xff ? Buffer.from([0x28, u]) : Buffer.from([0x29, u & 0xff, (u >> 8) & 0xff])
}

function cat(...chunks) {
  return Buffer.concat(chunks)
}

function mouseDescriptor() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    usage(0x01),
    collection(0),
    reportSize(1),
    reportCount(3),
    usagePage(0x09),
    usage(1),
    usage(2),
    usage(3),
    inputData(),
    // Padding bits must be Constant: hidreport rejects a Data/Variable item
    // whose reportCount exceeds its declared usages.
    reportSize(1),
    reportCount(5),
    inputData(0x01),
    reportSize(8),
    reportCount(2),
    usagePage(0x01),
    usage(0x30),
    usage(0x31),
    inputData(),
    endCollection(),
    endCollection()
  )
}

function keyboardDescriptor() {
  return cat(
    usagePage(0x01),
    usage(0x06),
    collection(),
    reportSize(1),
    reportCount(8),
    usagePage(0x07),
    usage(0xe0),
    usage(0xe1),
    usage(0xe2),
    usage(0xe3),
    usage(0xe4),
    usage(0xe5),
    usage(0xe6),
    usage(0xe7),
    inputData(),
    // Reserved byte is Constant, and the 6-key list is an Array: both dodge
    // hidreport's "Missing Usages for main item" check (Data/Variable items
    // need a usage per report count). Matches the standard boot keyboard
    // descriptor shape.
    reportSize(8),
    reportCount(1),
    inputData(0x01),
    reportSize(8),
    reportCount(6),
    usage(0x00),
    inputData(0x00),
    endCollection()
  )
}

function vendorDescriptor() {
  return cat(
    usagePage(0x01),
    usage(0x04),
    collection(),
    usage(0x01),
    collection(0),
    reportSize(8),
    reportCount(3),
    usagePage(0x01),
    usage(0x30),
    usage(0x31),
    usage(0x38),
    inputData(),
    endCollection(),
    endCollection(),
    // The report ID lives inside the collection: Chromium's HID parser does
    // not carry the Report ID global across a top-level collection boundary
    // (it parsed this report as unnumbered when the ID sat between the two
    // collections), which made native WebHID sendReport(1, ...) fail with
    // "Failed to write the report".
    usagePage(0xff1c),
    usage(0x92),
    collection(),
    reportId(1),
    reportSize(8),
    reportCount(64),
    usage(0x01),
    inputData(),
    usage(0x02),
    outputData(),
    endCollection()
  )
}

function gamepadDescriptor() {
  return cat(
    usagePage(0x01),
    usage(0x04),
    collection(),
    reportSize(8),
    reportCount(4),
    usage(0x01),
    usage(0x30),
    usage(0x31),
    usage(0x32),
    usage(0x35),
    inputData(),
    reportSize(1),
    reportCount(8),
    usagePage(0x09),
    usage(1),
    usage(2),
    usage(3),
    usage(4),
    usage(5),
    usage(6),
    usage(7),
    usage(8),
    inputData(),
    endCollection()
  )
}

const DESCRIPTORS = {
  'mouse.bin': mouseDescriptor(),
  'keyboard.bin': keyboardDescriptor(),
  'vendor.bin': vendorDescriptor(),
  'gamepad.bin': gamepadDescriptor()
}

function edgeEmpty() {
  return Buffer.alloc(0)
}

function edgeSingleByte() {
  return Buffer.from([0xff])
}

function edgeTruncatedInput() {
  return Buffer.from([0x81])
}

function edgeTruncatedLongItem() {
  return Buffer.from([0xfe, 0xff])
}

function edgeUnclosedCollection() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(8),
    reportCount(1),
    usagePage(0x09),
    usage(1),
    inputData()
  )
}

function edgeExtraEndCollection() {
  return Buffer.from([0xc0])
}

function edgeDeepNesting() {
  const chunks = []
  for (let i = 0; i < 32; i++) {
    chunks.push(usagePage(0x01), usage(0x02), collection())
  }
  chunks.push(reportSize(8), reportCount(1), usagePage(0x09), usage(1), inputData())
  for (let i = 0; i < 32; i++) chunks.push(endCollection())
  return Buffer.concat(chunks)
}

function edgeReportSizeZero() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(0),
    reportCount(64),
    usagePage(0x09),
    usage(1),
    logicalMin(0),
    logicalMax(1),
    inputData(),
    endCollection()
  )
}

function edgeReportCountZero() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(8),
    reportCount(0),
    usagePage(0x09),
    usage(1),
    logicalMin(0),
    logicalMax(1),
    inputData(),
    endCollection()
  )
}

function edgeLogicalMaxFFFFFFFF() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(8),
    reportCount(1),
    usagePage(0x09),
    usage(1),
    logicalMin(0),
    Buffer.from([0x27, 0xff, 0xff, 0xff, 0xff]),
    inputData(),
    endCollection()
  )
}

function edgeMultipleReportIds() {
  const reportChunks = [usagePage(0x01), usage(0x02), collection(), usage(0x01), collection(0)]
  for (const rid of [1, 2, 3]) {
    reportChunks.push(
      reportId(rid),
      reportSize(8),
      reportCount(4),
      usagePage(0x01),
      usage(0x30),
      usage(0x31),
      usage(0x32),
      usage(0x35),
      inputData()
    )
  }
  reportChunks.push(endCollection(), endCollection())
  return Buffer.concat(reportChunks)
}

function edgeUsagePageFFFF() {
  return cat(
    usagePage(0xffff),
    usage(0xffff),
    collection(),
    reportSize(8),
    reportCount(1),
    usagePage(0xffff),
    usage(0x01),
    logicalMin(0),
    logicalMax(255),
    inputData(),
    endCollection()
  )
}

function edgeReportSizeMax() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(32),
    reportCount(0xff),
    usagePage(0x09),
    usage(1),
    logicalMin(0),
    logicalMax(0xffffffff),
    inputData(),
    endCollection()
  )
}

function edgeCollectionOnly() {
  return cat(usagePage(0x01), usage(0x02), collection(), endCollection())
}

function edgeUnitExponentOverflow() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(8),
    reportCount(1),
    usagePage(0x09),
    usage(1),
    logicalMin(0),
    logicalMax(255),
    unitExponent(0x0f),
    inputData(),
    endCollection()
  )
}

function edgeVendorExtendedUsage() {
  return cat(
    usagePage(0xff00),
    usage(0x01),
    collection(),
    reportSize(8),
    reportCount(16),
    usageMinimum(0x01),
    usageMaximum(0x10),
    logicalMin(0),
    logicalMax(255),
    inputData(0x00),
    endCollection()
  )
}

function edgeValidHasOutputButNoInput() {
  return cat(
    usagePage(0x01),
    usage(0x06),
    collection(),
    reportSize(8),
    reportCount(8),
    usagePage(0x07),
    usage(0xe0),
    usage(0xe1),
    usage(0xe2),
    usage(0xe3),
    usage(0xe4),
    usage(0xe5),
    usage(0xe6),
    usage(0xe7),
    outputData(),
    endCollection()
  )
}

function edgeVariableAfterArray() {
  return cat(
    usagePage(0x01),
    usage(0x02),
    collection(),
    reportSize(8),
    reportCount(4),
    usagePage(0x07),
    usageMinimum(0x00),
    usageMaximum(0x03),
    logicalMin(0),
    logicalMax(255),
    inputData(0x00),
    reportSize(8),
    reportCount(2),
    usagePage(0x01),
    usage(0x30),
    usage(0x31),
    inputData(0x02),
    endCollection()
  )
}

const EDGE_DESCRIPTORS = {
  'empty.bin': edgeEmpty(),
  'single-byte.bin': edgeSingleByte(),
  'truncated-input.bin': edgeTruncatedInput(),
  'truncated-long-item.bin': edgeTruncatedLongItem(),
  'unclosed-collection.bin': edgeUnclosedCollection(),
  'extra-end-collection.bin': edgeExtraEndCollection(),
  'deep-nesting.bin': edgeDeepNesting(),
  'report-size-zero.bin': edgeReportSizeZero(),
  'report-count-zero.bin': edgeReportCountZero(),
  'logical-max-ffffffff.bin': edgeLogicalMaxFFFFFFFF(),
  'multiple-report-ids.bin': edgeMultipleReportIds(),
  'usage-page-ffff.bin': edgeUsagePageFFFF(),
  'report-size-max.bin': edgeReportSizeMax(),
  'collection-only.bin': edgeCollectionOnly(),
  'unit-exponent-overflow.bin': edgeUnitExponentOverflow(),
  'vendor-extended-usage.bin': edgeVendorExtendedUsage(),
  'valid-no-input-reports.bin': edgeValidHasOutputButNoInput(),
  'variable-after-array.bin': edgeVariableAfterArray()
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  for (const [name, desc] of Object.entries(DESCRIPTORS)) {
    const path = join(OUT_DIR, name)
    await writeFile(path, desc)
    console.log(`wrote ${path} (${desc.length} bytes)`)
  }

  await mkdir(EDGE_DIR, { recursive: true })
  for (const [name, desc] of Object.entries(EDGE_DESCRIPTORS)) {
    const path = join(EDGE_DIR, name)
    await writeFile(path, desc)
    console.log(`wrote ${path} (${desc.length} bytes)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
