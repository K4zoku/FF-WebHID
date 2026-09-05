use super::*;

#[test]
fn refreshes_for_hid_arrival_and_removal_completion_only() {
    assert!(should_refresh_device_change(DBT_DEVICEARRIVAL));
    assert!(should_refresh_device_change(DBT_DEVICEREMOVECOMPLETE));
    assert!(!should_refresh_device_change(0x8001));
    assert!(!should_refresh_device_change(0x0007));
}
