use super::*;

#[test]
fn test_prune_old_logs_only_touches_stale_webhid_files() {
    let dir = std::env::temp_dir().join(format!("webhid-log-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let stale = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(30 * 24 * 3600))
        .unwrap();
    let set_old = |name: &str| {
        let path = dir.join(name);
        std::fs::write(&path, b"x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
    };

    let fresh = dir.join("webhid-100.log");
    std::fs::write(&fresh, b"x").unwrap();
    set_old("webhid-1.log");
    set_old("webhid-2.log.1");
    set_old("other.log");

    prune_old_logs(&dir);

    assert!(fresh.exists(), "fresh log must survive");
    assert!(
        !dir.join("webhid-1.log").exists(),
        "stale log must be removed"
    );
    assert!(
        !dir.join("webhid-2.log.1").exists(),
        "stale rotated log must be removed"
    );
    assert!(
        dir.join("other.log").exists(),
        "unrelated file must survive"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
