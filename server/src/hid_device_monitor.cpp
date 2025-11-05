#include <hid_device_monitor>

using namespace HID;
using namespace std;

namespace HID {
void HIDDeviceMonitor::setOnConnectCallback(HIDConnection::Callback callback) { onConnect = callback; }
void HIDDeviceMonitor::setOnDisconnectCallback(HIDConnection::Callback callback) { onDisconnect = callback; }
} // namespace HID
