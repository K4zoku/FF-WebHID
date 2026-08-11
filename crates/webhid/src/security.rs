/// No-op on non-Linux or debug builds.
#[cfg(not(all(feature = "hardening", target_os = "linux", not(debug_assertions))))]
pub fn apply_prctl_hardening() {}

/// Apply process-wide hardening via prctl (Linux, release-only).
#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
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
#[cfg(not(all(feature = "hardening", target_os = "linux", not(debug_assertions))))]
pub fn apply_seccomp_filter<T>(_syscalls: &[T]) {}

/// Apply a strict seccomp BPF allow-list filter (Linux, release-only).
/// Panics via `exit(1)` if installation fails (security-critical).
#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
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

/// Syscall allow-list for the daemon process.
#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
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
    libc::SYS_mkdir,
    libc::SYS_unlink,
    libc::SYS_chmod,
    libc::SYS_fstat,
    libc::SYS_fstatfs,
    libc::SYS_newfstatat,
    libc::SYS_statx,
    libc::SYS_getdents64,
    libc::SYS_readlink,
    libc::SYS_readlinkat,
    libc::SYS_faccessat,
    libc::SYS_faccessat2,
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
    #[cfg(target_arch = "x86_64")]
    libc::SYS_arch_prctl,
    libc::SYS_prlimit64,
    libc::SYS_poll,
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
    libc::SYS_recvmmsg,
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
    libc::SYS_sched_getaffinity,
    libc::SYS_sched_yield,
    libc::SYS_fsync,
    libc::SYS_fdatasync,
];

/// Syscall allow-list for the NM forwarder (pure byte pipe, no server).
#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
pub const NM_SYSCALLS: &[libc::c_long] = &[
    libc::SYS_read,
    libc::SYS_write,
    libc::SYS_pread64,
    libc::SYS_pwrite64,
    libc::SYS_readv,
    libc::SYS_writev,
    libc::SYS_close,
    libc::SYS_dup,
    libc::SYS_fcntl,
    libc::SYS_lseek,
    libc::SYS_openat,
    libc::SYS_fstat,
    libc::SYS_newfstatat,
    #[cfg(target_arch = "x86_64")]
    libc::SYS_access,
    libc::SYS_mmap,
    libc::SYS_munmap,
    libc::SYS_mprotect,
    libc::SYS_brk,
    libc::SYS_madvise,
    #[cfg(target_arch = "x86_64")]
    libc::SYS_arch_prctl,
    libc::SYS_prlimit64,
    libc::SYS_poll,
    libc::SYS_socket,
    libc::SYS_connect,
    libc::SYS_getsockname,
    libc::SYS_setsockopt,
    libc::SYS_getsockopt,
    libc::SYS_sendmsg,
    libc::SYS_recvmsg,
    libc::SYS_epoll_create1,
    libc::SYS_epoll_ctl,
    #[cfg(target_arch = "x86_64")]
    libc::SYS_epoll_wait,
    libc::SYS_eventfd2,
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
    libc::SYS_getppid,
    libc::SYS_gettid,
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
    libc::SYS_getrandom,
    libc::SYS_prctl,
    libc::SYS_pipe2,
    libc::SYS_uname,
    libc::SYS_sched_getaffinity,
    libc::SYS_sched_yield,
];

#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
fn build_filter(syscalls: &[libc::c_long]) -> Vec<libc::sock_filter> {
    use libc::*;

    const SECCOMP_DATA_NR_OFFSET: u32 = 0;
    const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

    let mut insns = Vec::new();

    unsafe {
        insns.push(BPF_STMT(
            (BPF_LD | BPF_W | BPF_ABS) as u16,
            SECCOMP_DATA_ARCH_OFFSET,
        ));
        insns.push(BPF_JUMP((BPF_JMP | BPF_JEQ) as u16, AUDIT_ARCH, 1, 0));
        insns.push(BPF_STMT((BPF_RET | BPF_K) as u16, SECCOMP_RET_KILL_PROCESS));

        insns.push(BPF_STMT(
            (BPF_LD | BPF_W | BPF_ABS) as u16,
            SECCOMP_DATA_NR_OFFSET,
        ));

        for &nr in syscalls {
            insns.push(BPF_JUMP((BPF_JMP | BPF_JEQ) as u16, nr as u32, 0, 1));
            insns.push(BPF_STMT((BPF_RET | BPF_K) as u16, SECCOMP_RET_ALLOW));
        }

        insns.push(BPF_STMT((BPF_RET | BPF_K) as u16, SECCOMP_RET_KILL_PROCESS));
    }

    insns
}

#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xC000_003E;

#[cfg(all(feature = "hardening", target_os = "linux", not(debug_assertions)))]
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xC000_00B7;
