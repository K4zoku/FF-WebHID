## What does this PR do?

<!-- Briefly describe the change and why it's needed -->

## Related issue(s)

<!-- Closes #123, if applicable -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Packaging / CI
- [ ] Documentation
- [ ] Other (please describe)

## Testing

<!-- How did you test this? Which platform(s)? Which HID device(s), if relevant? -->

**Daemon (Rust)**
- [ ] `cargo build --release` passes
- [ ] `cargo clippy` passes with no new warnings
- [ ] `cargo test` passes (unit tests, not full e2e coverage)
- [ ] Tested against a real HID device if the change touches enumeration, report descriptor parsing, or the data plane (specify device/platform below if so)

**Addon (JS)**
- [ ] Manually tested the changed area in the browser (no automated addon tests yet)

## Checklist

- [ ] I've read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] My commit messages follow Conventional Commits style
- [ ] I've updated relevant docs (README, DEVELOPMENT.md, ARCHITECTURE.md) if needed
