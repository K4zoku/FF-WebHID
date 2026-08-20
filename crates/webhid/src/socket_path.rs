//! Default IPC socket/pipe path resolution, shared by the daemon (binds one
//! path) and the NM forwarder (tries candidates in order).
//!
//! Keeping both policies in one module makes their deliberate difference
//! explicit: the daemon only binds the root abstract socket when running as
//! root (a non-root daemon must not shadow the system-wide name), while the
//! forwarder always tries the abstract socket first, then the per-user
//! runtime socket, then the root filesystem socket.

pub fn override_path() -> Option<String> {
    std::env::var("WEBHID_SOCKET")
        .ok()
        .filter(|p| !p.is_empty())
}

#[cfg(target_os = "linux")]
pub const ROOT_ABSTRACT_SOCKET: &str = "@webhid";

#[cfg(target_os = "linux")]
pub const ROOT_FS_SOCKET: &str = "/run/webhid/webhid.sock";

#[cfg(target_os = "linux")]
pub fn user_socket() -> String {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR")
        && !dir.is_empty()
    {
        let p = std::path::Path::new(&dir);
        if p.is_absolute() && !dir.contains("..") {
            return format!("{dir}/webhid/webhid.sock");
        }
    }
    let uid = unsafe { libc::getuid() };
    format!("/run/user/{uid}/webhid/webhid.sock")
}

#[cfg(target_os = "macos")]
/// Per-user socket under the user's own Application Support directory. The
/// home directory is only reachable by its owner, so no peer verification
/// or world-writable /tmp naming is needed for cross-user isolation.
/// Falls back to the legacy fixed /tmp path when HOME is unavailable.
pub fn macos_socket() -> String {
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return format!("{home}/Library/Application Support/webhid/webhid.sock");
    }
    "/tmp/webhid.sock".to_string()
}

#[cfg(target_os = "windows")]
pub const PIPE: &str = r"\\.\pipe\webhid";

#[cfg(unix)]
pub fn daemon_socket_path() -> String {
    if let Some(path) = override_path() {
        return path;
    }
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::geteuid() } == 0 {
            return ROOT_ABSTRACT_SOCKET.to_string();
        }
        user_socket()
    }
    #[cfg(target_os = "macos")]
    macos_socket()
}

#[cfg(unix)]
pub fn forwarder_socket_candidates() -> Vec<String> {
    if let Some(path) = override_path() {
        return vec![path];
    }
    let mut candidates = Vec::new();
    #[cfg(target_os = "linux")]
    {
        candidates.push(ROOT_ABSTRACT_SOCKET.to_string());
        candidates.push(user_socket());
        candidates.push(ROOT_FS_SOCKET.to_string());
    }
    #[cfg(target_os = "macos")]
    candidates.push(macos_socket());
    candidates
}
