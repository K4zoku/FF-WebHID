#include <trlc/platform/platform.hpp>
#ifdef TRLC_PLATFORM_LINUX

#include <hid_device_monitor>

using namespace HID;
using namespace std;

void setupMonitor(udev_monitor *monitor);

namespace HID {
HIDDeviceMonitor::HIDDeviceMonitor() : running(false) {
  udev = udev_new();
  if (!udev) {
    throw std::runtime_error("Failed to initialize udev");
  }
  monitor = udev_monitor_new_from_netlink(udev, "udev");
  if (!monitor) {
    throw std::runtime_error("Failed to create udev monitor");
  }
  udev_monitor_filter_add_match_subsystem_devtype(monitor, "hidraw", nullptr);
  udev_monitor_enable_receiving(monitor);
}

HIDDeviceMonitor::~HIDDeviceMonitor() {
  if (isRunning())
    stop();
  if (monitor) {
    udev_monitor_unref(monitor);
    monitor = nullptr;
  }
  if (udev) {
    udev_unref(udev);
    udev = nullptr;
  }
}

bool HIDDeviceMonitor::isRunning() { return running; }

bool HIDDeviceMonitor::loop() {
  int fd = udev_monitor_get_fd(monitor);
  fd_set readfds;
  FD_ZERO(&readfds);
  FD_SET(fd, &readfds);
  struct timeval timeout = {0, 0};
  int result = select(fd + 1, &readfds, nullptr, nullptr, &timeout);
  if (result == -1 || !FD_ISSET(fd, &readfds)) {
    return false;
  }
  struct udev_device *udevDevice = udev_monitor_receive_device(monitor);
  if (!udevDevice) {
    cerr << "Failed to receive device" << endl;
    return false;
  }
  const char *action = udev_device_get_action(udevDevice);
  if (!action) {
    cerr << "Failed to get action" << endl;
    return false;
  }
  HIDConnection::Callback callback;
  if (strcmp(action, "add") == 0)
    callback = onConnect;
  else if (strcmp(action, "remove") == 0)
    callback = onDisconnect;
  else
    return false;

  const char *rawVendorId = udev_device_get_property_value(udevDevice, "ID_VENDOR_ID");
  const char *rawProductId = udev_device_get_property_value(udevDevice, "ID_MODEL_ID");
  if (!(rawVendorId && rawProductId)) {
    return false;
  }
  const unsigned short vendorId = strtol(rawVendorId, nullptr, 16);
  const unsigned short productId = strtol(rawProductId, nullptr, 16);
  udev_device_unref(udevDevice);

  vector<HIDDevice> devices = HIDDevice::requestDevice({vendorId, productId});
  if (devices.empty()) {
    return false;
  }
  HIDDevice device = devices.front();
  callback(device);
  return true;
}

void HIDDeviceMonitor::run() {
  while (running) {
    if (loop()) {
      continue;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
}

void HIDDeviceMonitor::start() {
  running = true;
  monitorThread = unique_ptr<thread>(new thread(&HIDDeviceMonitor::run, this));
}

void HIDDeviceMonitor::stop() {
  running = false;
  if (monitorThread->joinable()) {
    monitorThread->join();
  }
}

} // namespace HID
#endif
