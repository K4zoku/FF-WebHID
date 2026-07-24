/// No-op on non-Linux or debug builds.
#[cfg(not(all(target_os = "linux", not(debug_assertions))))]
pub fn apply_prctl_hardening() {}

/// Apply process-wide hardening via prctl (Linux, release-only).
#[cfg(all(target_os = "linux", not(debug_assertions)))]
pub fn apply_prctl_hardening() {
    let ret = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
    if ret != 0 {
        log::warn!(
            "[security] PR_SET_DUMPABLE failed: {}",
            std::io::Error::last_os_error()
        );
    }

    let ret = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if ret != 0 {
        log::warn!(
            "[security] PR_SET_NO_NEW_PRIVS failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// No-op on non-Linux or debug builds.
#[cfg(not(all(target_os = "linux", not(debug_assertions))))]
pub fn apply_seccomp_filter<T>(_syscalls: &[T]) {}

/// Apply a strict seccomp BPF filter (Linux, release-only).
///
/// Uses an allow-list approach: only the given `syscalls` are permitted;
/// everything else kills the process.  The filter is applied to all current
/// and future threads (via `SECCOMP_FILTER_FLAG_TSYNC`).
///
/// # Panics
/// Calls `std::process::exit(1)` if the filter cannot be installed, since
/// failing to seccomp is a security-critical failure.
#[cfg(all(target_os = "linux", not(debug_assertions)))]
pub fn apply_seccomp_filter(syscalls: &[libc::c_long]) {
    let filter = build_filter(syscalls);
    let mut prog = libc::sock_fprog {
        len: filter.len() as u16,
        filter: Box::into_raw(filter.into_boxed_slice()) as *mut libc::sock_filter,
    };

    let ret = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            libc::SECCOMP_SET_MODE_FILTER,
            libc::SECCOMP_FILTER_FLAG_TSYNC as libc::c_ulong,
            &mut prog as *mut libc::sock_fprog,
        )
    };

    drop(unsafe { Box::from_raw(prog.filter) });

    if ret != 0 {
        log::error!(
            "[security] seccomp filter FAILED: {}",
            std::io::Error::last_os_error()
        );
        std::process::exit(1);
    }
    log::info!("[security] seccomp BPF filter applied");
}

#[cfg(all(target_os = "linux", not(debug_assertions)))]
fn build_filter(syscalls: &[libc::c_long]) -> Vec<libc::sock_filter> {
    use libc::*;

    const SECCOMP_DATA_NR_OFFSET: u32 = 0;
    const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

    let mut insns = Vec::new();

    // ── Architecture check ───────────────────────────────────────────
    unsafe {
        insns.push(BPF_STMT(
            (BPF_LD | BPF_W | BPF_ABS) as u16,
            SECCOMP_DATA_ARCH_OFFSET,
        ));
        insns.push(BPF_JUMP(
            (BPF_JMP | BPF_JEQ) as u16,
            AUDIT_ARCH,
            0,
            1,
        ));
        insns.push(BPF_STMT(
            (BPF_RET | BPF_K) as u16,
            SECCOMP_RET_KILL_PROCESS,
        ));

        insns.push(BPF_STMT(
            (BPF_LD | BPF_W | BPF_ABS) as u16,
            SECCOMP_DATA_NR_OFFSET,
        ));

        for &nr in syscalls {
            insns.push(BPF_JUMP(
                (BPF_JMP | BPF_JEQ) as u16,
                nr as u32,
                0,
                1,
            ));
            insns.push(BPF_STMT((BPF_RET | BPF_K) as u16, SECCOMP_RET_ALLOW));
        }

        insns.push(BPF_STMT(
            (BPF_RET | BPF_K) as u16,
            SECCOMP_RET_KILL_PROCESS,
        ));
    }

    insns
}

#[cfg(all(target_os = "linux", not(debug_assertions)))]
#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xC000_003E; // AUDIT_ARCH_X86_64

#[cfg(all(target_os = "linux", not(debug_assertions)))]
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xC000_00B7; // AUDIT_ARCH_AARCH64
