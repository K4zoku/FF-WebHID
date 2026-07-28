pub mod collections_tlv;
pub mod logging;
pub mod protocol;
pub mod security;
pub mod types;

pub use types::*;

/// FNV-1a 32-bit hash of a device path/syspath for a stable u32 device identifier.
pub fn hash_device_id(path: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5; // FNV offset basis
    for b in path.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193); // FNV prime
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_device_id_empty() {
        // FNV-1a of empty string
        assert_eq!(hash_device_id(""), 0x811c9dc5);
    }

    #[test]
    fn test_hash_device_id_different_strings() {
        let h1 = hash_device_id("/dev/hidraw0");
        let h2 = hash_device_id("/dev/hidraw1");
        assert_ne!(h1, h2, "different paths should produce different hashes");
    }

    #[test]
    fn test_hash_device_id_deterministic() {
        let h1 = hash_device_id("/dev/hidraw0");
        let h2 = hash_device_id("/dev/hidraw0");
        assert_eq!(h1, h2, "same path should produce same hash");
    }

    #[test]
    fn test_hash_device_id_all_byte_values() {
        for byte in 0..=255u8 {
            let buf = [byte];
            let s = core::str::from_utf8(&buf).unwrap_or("\x00");
            hash_device_id(s);
        }
    }
}
