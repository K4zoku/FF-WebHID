use super::*;

#[test]
fn test_pack_usage() {
    let u = Usage {
        usage_page: 0x0001.into(),
        usage_id: 0x0002.into(),
    };
    assert_eq!(pack_usage(&u), 0x0001_0002);
}

#[test]
fn test_pack_usage_fido() {
    let u = Usage {
        usage_page: 0xF1D0.into(),
        usage_id: 0x0001.into(),
    };
    assert_eq!(pack_usage(&u), 0xF1D0_0001);
}

#[test]
fn test_nibble_as_i8_positive() {
    assert_eq!(nibble_as_i8(0), 0);
    assert_eq!(nibble_as_i8(7), 7);
}

#[test]
fn test_nibble_as_i8_negative() {
    assert_eq!(nibble_as_i8(15), -1);
    assert_eq!(nibble_as_i8(8), -8);
}

#[test]
fn test_decode_unit_safe_none() {
    let (sys, len, mass, time, temp, cur, lum) = decode_unit_safe(None);
    assert_eq!(sys, "none");
    assert_eq!((len, mass, time, temp, cur, lum), (0, 0, 0, 0, 0, 0));
}

#[test]
fn test_detect_contiguous_range_single() {
    let usages = vec![0x0001_0002u32];
    let (u, is_range, _lo, _hi) = detect_contiguous_range(usages.clone());
    assert!(!is_range);
    assert_eq!(u, usages);
}

#[test]
fn test_detect_contiguous_range_full() {
    let usages = vec![0x0001_00E0, 0x0001_00E1, 0x0001_00E2];
    let (u, is_range, lo, hi) = detect_contiguous_range(usages);
    assert!(is_range);
    assert!(u.is_empty());
    assert_eq!(lo, Some(0x0001_00E0));
    assert_eq!(hi, Some(0x0001_00E2));
}

#[test]
fn test_detect_contiguous_range_different_pages() {
    let usages = vec![0x0001_00E0, 0x0002_00E1];
    let (u, is_range, lo, hi) = detect_contiguous_range(usages.clone());
    assert!(!is_range);
    assert_eq!(u, usages);
    assert_eq!(lo, None);
    assert_eq!(hi, None);
}

#[test]
fn test_detect_contiguous_range_non_sequential() {
    let usages = vec![0x0001_00E0, 0x0001_00E2];
    let (u, is_range, lo, hi) = detect_contiguous_range(usages.clone());
    assert!(!is_range);
    assert_eq!(u, usages);
    assert_eq!(lo, None);
    assert_eq!(hi, None);
}

#[test]
fn test_detect_contiguous_range_overflow_safe() {
    let usages = vec![0x0001_FFFF, 0x0002_0000];
    let (u, is_range, _lo, _hi) = detect_contiguous_range(usages.clone());
    assert!(!is_range);
    assert_eq!(u, usages);
}
