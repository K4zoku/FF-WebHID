#include <codecvt>
#include <hid_device>
#include <hidapi.h>
#include <locale>

namespace HID {
using namespace std;
vector<HIDDevice> HIDDevice::getDevices() {
  vector<HIDDevice> devices;

  hid_device_info *hidDevices = hid_enumerate(0, 0);
  for (const hid_device_info *info = hidDevices; info != nullptr; info = info->next) {
    HIDDevice device = HIDDevice(info);
    devices.push_back(device);
  }

  return devices;
}

bool satisfiesFilter(const hid_device_info *info, const HIDDeviceFilter &filter,
                     const HIDDeviceFilter &exclusionFilter) {
  if (filter.vendorId && filter.vendorId != info->vendor_id) {
    return false;
  }

  if (filter.productId && filter.productId != info->product_id) {
    return false;
  }

  if (filter.usagePage && filter.usagePage != info->usage_page) {
    return false;
  }

  if (filter.usage && filter.usage != info->usage) {
    return false;
  }

  if (exclusionFilter.vendorId && exclusionFilter.vendorId == info->vendor_id) {
    return false;
  }

  if (exclusionFilter.productId && exclusionFilter.productId == info->product_id) {
    return false;
  }

  if (exclusionFilter.usagePage && exclusionFilter.usagePage == info->usage_page) {
    return false;
  }

  if (exclusionFilter.usage && exclusionFilter.usage == info->usage) {
    return false;
  }

  return true;
}

vector<HIDDevice> HIDDevice::requestDevice(const HIDDeviceFilter &filter, const HIDDeviceFilter &exclusionFilter) {
  vector<HIDDevice> devices;

  hid_device_info *hidDevices = hid_enumerate(filter.vendorId, filter.productId);
  for (const hid_device_info *info = hidDevices; info != nullptr; info = info->next) {
    if (satisfiesFilter(info, filter, exclusionFilter)) {
      HIDDevice device = HIDDevice(info);
      devices.push_back(device);
    }
  }
  hid_free_enumeration(hidDevices);

  return devices;
}

HIDDevice::HIDDevice(const hid_device_info *info)
    : vendorId(info->vendor_id), productId(info->product_id), productName(wstring(info->product_string)) {
  hid_device *device = hid_open(info->vendor_id, info->product_id, NULL);
  if (!device) {
    wstring error = wstring(hid_error(device));
    using convert_type = std::codecvt_utf8<wchar_t>;
    std::wstring_convert<convert_type, wchar_t> converter;
    std::string msg = string("Failed to open HID device: ") + converter.to_bytes(error);
    throw runtime_error(msg);
  }
}

string HIDDevice::toString() const {
  string result;
  result += to_string(vendorId);
  result += to_string(productId);
  using convert_type = std::codecvt_utf8<wchar_t>;
  std::wstring_convert<convert_type, wchar_t> converter;
  result += converter.to_bytes(productName);
  return result;
}

size_t HIDDevice::hash() const {
  return std::hash<std::string>()(toString());
}

} // namespace HID
