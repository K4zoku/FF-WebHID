pub fn init_logger() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);
    if log::set_boxed_logger(Box::new(SimpleLogger)).is_ok() {
        log::set_max_level(level);
    }
}

struct SimpleLogger;

impl log::Log for SimpleLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!(
                "[{:5} {}] {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }
    fn flush(&self) {}
}
