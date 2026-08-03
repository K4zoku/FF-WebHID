use std::io::Write;
use std::sync::Mutex;

/// Initialize the process-wide logger.
pub fn init_logger() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);
    let file = std::env::var("WEBHID_LOG_FILE").ok().and_then(|path| {
        match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => Some(f),
            Err(e) => {
                eprintln!("[logger] cannot open WEBHID_LOG_FILE '{path}': {e}; continuing without file log");
                None
            }
        }
    });
    if log::set_boxed_logger(Box::new(SimpleLogger {
        file: Mutex::new(file),
    }))
    .is_ok()
    {
        log::set_max_level(level);
    }
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
