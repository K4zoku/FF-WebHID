# WebHID for Firefox

https://github.com/libusb/hidapi

add udev rules
```js
SUBSYSTEM=="hidraw", KERNEL=="hidraw*", ATTRS{idVendor}=="xxxx", ATTRS{idProduct}=="xxxx", TAG+="uaccess"
```

reload udev rules
```sh
sudo udevadm control --reload-rules
sudo udevadm trigger
```

```sh
#!/usr/bin/env sh
HIDRAWS=/dev/hidraw*
for HIDRAW in $HIDRAWS
do
  source /sys/class/hidraw/$(basename ${HIDRAW})/device/uevent
  printf "%s %s" "${HID_UNIQ}" "${HID_NAME}"
done
```
