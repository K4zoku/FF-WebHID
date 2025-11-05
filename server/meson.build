project(
  'WebHIDServer',
  'cpp',
  version : '0.1',
  meson_version : '>= 1.3.0',
  default_options : ['warning_level=3', 'cpp_std=c++14'],
)

dependencies = [
  dependency('threads'),
  dependency('hidapi')
]

if host_machine.system() == 'linux'
  dependencies += dependency('libudev')
endif


source = [
  'src/main.cpp',
  'src/hid_device.cpp',
  'src/hid_device_monitor.cpp',
  'src/hid_device_monitor.linux.cpp'
]

include = include_directories(
  'include',
  'lib/atomic_queue/include',
  'lib/trlc-platform/include',
)

exe = executable(
  'WebHIDServer',
  source,
  install : true,
  dependencies : dependencies,
  include_directories : include
)
