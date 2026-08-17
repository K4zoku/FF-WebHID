#[cfg(target_os = "linux")]
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
use tokio::net::UnixStream;

#[cfg(target_os = "linux")]
fn resolve_webhid_gid() -> Option<libc::gid_t> {
    static GID: OnceLock<Option<libc::gid_t>> = OnceLock::new();
    *GID.get_or_init(|| {
        let name = c"webhid".as_ptr();
        let grp = unsafe { libc::getgrnam(name) };
        if grp.is_null() {
            log::warn!("[security] 'webhid' group not found on system");
            return None;
        }
        let gid = unsafe { (*grp).gr_gid };
        log::info!("[security] resolved webhid GID = {gid}");
        Some(gid)
    })
}

/// Verify that the peer on the other end of a Unix socket connection
/// belongs to the `webhid` group.
///
/// Returns `true` if the peer's credentials are acceptable, `false` otherwise.
#[cfg(target_os = "linux")]
pub fn verify_peer(stream: &UnixStream) -> bool {
    let cred = match stream.peer_cred() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[security] peer_cred() failed: {e}");
            return false;
        }
    };

    let target_gid = match resolve_webhid_gid() {
        Some(g) => g,
        None => {
            log::warn!("[security] no webhid group configured, denying all peers");
            return false;
        }
    };

    if cred.gid() == target_gid {
        return true;
    }
    log::debug!(
        "[security] primary GID {} != webhid GID {}, checking supplementary groups",
        cred.gid(),
        target_gid
    );

    #[cfg(target_os = "linux")]
    if let Some(pid) = cred.pid() {
        return check_supplementary_groups(pid, target_gid);
    }

    log::warn!(
        "[security] peer (uid={}, gid={}) not in webhid group; rejecting",
        cred.uid(),
        cred.gid(),
    );
    false
}

/// Check supplementary groups of the given PID for the target GID.
#[cfg(target_os = "linux")]
fn check_supplementary_groups(pid: libc::pid_t, target_gid: libc::gid_t) -> bool {
    use std::io::BufRead;

    let path = format!("/proc/{pid}/status");
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("[security] cannot open {path}: {e}");
            return false;
        }
    };

    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            _ => continue,
        };
        if let Some(groups_str) = line.strip_prefix("Groups:\t") {
            for gid_str in groups_str.split_whitespace() {
                if let Ok(gid) = gid_str.parse::<libc::gid_t>()
                    && gid == target_gid
                {
                    return true;
                }
            }
            return false;
        }
    }
    false
}
