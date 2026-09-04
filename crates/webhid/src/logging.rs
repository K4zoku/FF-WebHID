use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Cap for the default log file. On exceed the file is rotated to
/// `<file>.1` at startup.
const MAX_LOG_FILE_BYTES: u64 = 1 << 20;

/// Age past which per-instance log files from previous sessions are
/// deleted at startup. Referenced only from the Windows default path, but
/// kept compiled everywhere so the cleanup logic stays testable on Linux.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MAX_LOG_AGE: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 3600);

/// Initialize the process-wide logger.
///
/// Log lines go to stderr always. When `WEBHID_LOG_FILE` is set, lines are
/// also appended to that file. When it is not set and the platform has a
/// sensible default location (Windows: `%LOCALAPPDATA%\FF-WebHID\webhid-<pid>.log`),
/// the file log is enabled there automatically: the daemon is spawned by
/// Firefox as a native-messaging host, so its stderr is invisible to users,
/// and issue reports need daemon logs they can actually reach. Each process
/// gets its own file (one daemon/forwarder instance per Firefox session),
/// so concurrent sessions never interleave in one file.
pub fn init_logger() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);
    let (file, log_path) = match std::env::var("WEBHID_LOG_FILE") {
        Ok(path) => (open_log_file(&path), Some(path)),
        Err(_) => match default_log_file() {
            Some(path) => {
                rotate_if_needed(&path);
                let p = path.to_string_lossy().into_owned();
                (open_log_file(&p), Some(p))
            }
            None => (None, None),
        },
    };
    if log::set_boxed_logger(Box::new(SimpleLogger {
        file: Mutex::new(file),
    }))
    .is_ok()
    {
        log::set_max_level(level);
    }
    if let Some(path) = log_path {
        log::info!("logging to file {path}");
    }
}

/// Platform default log file location, when one exists. Per-process name
/// (`webhid-<pid>.log`) so concurrent daemon/forwarder instances (one per
/// Firefox session) each own a file and never interleave.
#[cfg(target_os = "windows")]
fn default_log_file() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let dir = PathBuf::from(local).join("FF-WebHID");
    std::fs::create_dir_all(&dir).ok()?;
    prune_old_logs(&dir);
    Some(dir.join(format!("webhid-{}.log", std::process::id())))
}

#[cfg(not(target_os = "windows"))]
fn default_log_file() -> Option<PathBuf> {
    None
}

/// Delete log files from previous instances that are old enough to be
/// useless. Only files matching our own naming pattern are touched, so
/// unrelated files in the directory are left alone. Runs once at startup;
/// races between concurrent instances are benign (worst case a file
/// survives one extra session). See [`MAX_LOG_AGE`] for why this is
/// compiled on all platforms.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn prune_old_logs(dir: &Path) {
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(MAX_LOG_AGE) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("webhid-") || (!name.ends_with(".log") && !name.ends_with(".log.1")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn open_log_file(path: &str) -> Option<std::fs::File> {
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("[logger] cannot open log file '{path}': {e}; continuing without file log");
            None
        }
    }
}

/// Rotate an oversized log file to `<path>.1` once at startup. Only the
/// process's own file is touched, so there is no cross-instance race.
fn rotate_if_needed(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX_LOG_FILE_BYTES {
        return;
    }
    let rotated = PathBuf::from(format!("{}.1", path.display()));
    let _ = std::fs::rename(path, &rotated);
}

struct SimpleLogger {
    file: Mutex<Option<std::fs::File>>,
}

impl log::Log for SimpleLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "[{:5} {}] {}\n",
            record.level(),
            record.target(),
            record.args()
        );
        eprint!("{line}");
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = file.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }
    fn flush(&self) {
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = file.as_mut() {
            let _ = f.flush();
        }
    }
}

#[cfg(test)]
#[path = "tests/logging.rs"]
mod tests;
