use std::sync::OnceLock;

use tokio::net::UnixStream;

/// Syscall allow-list for the daemon process.
#[cfg(all(target_os = "linux", not(debug_assertions)))]
pub const DAEMON_SYSCALLS: &[libc::c_long] = &[
    libc::SYS_read,
    libc::SYS_write,
    libc::SYS_pread64,
    libc::SYS_pwrite64,
    libc::SYS_readv,
    libc::SYS_writev,
    libc::SYS_close,
    libc::SYS_dup,
    libc::SYS_dup3,
    libc::SYS_fcntl,
    libc::SYS_ioctl,
    libc::SYS_lseek,
    libc::SYS_openat,
    libc::SYS_fstat,
    libc::SYS_newfstatat,
    libc::SYS_statx,
    libc::SYS_getdents64,
    libc::SYS_readlinkat,
    libc::SYS_faccessat,
    #[cfg(target_arch = "x86_64")]
    libc::SYS_access,
    libc::SYS_truncate,
    libc::SYS_ftruncate,
    libc::SYS_mmap,
    libc::SYS_munmap,
    libc::SYS_mprotect,
    libc::SYS_brk,
    libc::SYS_mremap,
    libc::SYS_madvise,
    libc::SYS_socket,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_accept4,
    libc::SYS_connect,
    libc::SYS_getsockname,
    libc::SYS_getpeername,
    libc::SYS_setsockopt,
    libc::SYS_getsockopt,
    libc::SYS_sendto,
    libc::SYS_recvfrom,
    libc::SYS_sendmsg,
    libc::SYS_recvmsg,
    libc::SYS_shutdown,
    libc::SYS_socketpair,
    libc::SYS_epoll_create1,
    libc::SYS_epoll_ctl,
    #[cfg(target_arch = "x86_64")]
    libc::SYS_epoll_wait,
    libc::SYS_epoll_pwait,
    libc::SYS_eventfd2,
    libc::SYS_timerfd_create,
    libc::SYS_timerfd_settime,
    libc::SYS_timerfd_gettime,
    libc::SYS_clone,
    libc::SYS_clone3,
    libc::SYS_futex,
    libc::SYS_set_robust_list,
    libc::SYS_get_robust_list,
    libc::SYS_set_tid_address,
    libc::SYS_rseq,
    libc::SYS_exit_group,
    libc::SYS_exit,
    libc::SYS_getpid,
    libc::SYS_gettid,
    libc::SYS_getppid,
    libc::SYS_getuid,
    libc::SYS_getgid,
    libc::SYS_geteuid,
    libc::SYS_getegid,
    libc::SYS_tgkill,
    libc::SYS_rt_sigaction,
    libc::SYS_rt_sigprocmask,
    libc::SYS_rt_sigreturn,
    libc::SYS_sigaltstack,
    libc::SYS_clock_gettime,
    libc::SYS_clock_nanosleep,
    libc::SYS_nanosleep,
    libc::SYS_gettimeofday,
    libc::SYS_getrandom,
    libc::SYS_prctl,
    libc::SYS_pipe2,
    libc::SYS_uname,
    libc::SYS_sched_yield,
    libc::SYS_fsync,
    libc::SYS_fdatasync,
];

/// Fallback: empty list for debug / non-Linux (seccomp is a no-op).
#[cfg(not(all(target_os = "linux", not(debug_assertions))))]
pub const DAEMON_SYSCALLS: &[()] = &[];

#[cfg(target_os = "linux")]
fn resolve_webhid_gid() -> Option<libc::gid_t> {
    static GID: OnceLock<Option<libc::gid_t>> = OnceLock::new();
    *GID.get_or_init(|| {
        let name = b"webhid\0".as_ptr() as *const libc::c_char;
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
                if let Ok(gid) = gid_str.parse::<libc::gid_t>() {
                    if gid == target_gid {
                        return true;
                    }
                }
            }
            return false;
        }
    }
    false
}


