pub mod collections_tlv;
pub mod logging;
pub mod protocol;
pub mod security;
pub mod socket_path;
pub mod types;

pub use types::*;

/// FNV-1a 32-bit hash of a device path/syspath for a stable u32 device identifier.
pub fn hash_device_id(path: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for b in path.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

#[cfg(test)]
#[path = "tests/lib.rs"]
mod tests;
