#include <iostream>
#include <hid_device_monitor>
using namespace std;
using namespace HID;
int main(__attribute__((unused)) int argc, __attribute__((unused)) char **argv) {
  HID::HIDDeviceMonitor monitor;
  monitor.setOnConnectCallback([](const HIDDevice &device) {
    using convert_type = std::codecvt_utf8<wchar_t>;
    std::wstring_convert<convert_type, wchar_t> converter;
    string name = converter.to_bytes(device.productName);
    cout << "Device connected: " << name << endl;
  });
  monitor.setOnDisconnectCallback([](const HIDDevice &device) {
    using convert_type = std::codecvt_utf8<wchar_t>;
    std::wstring_convert<convert_type, wchar_t> converter;
    string name = converter.to_bytes(device.productName);
    cout << "Device disconnected: " << name << endl;
  });
  monitor.start();
  while (true) {
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  return 0;
}
