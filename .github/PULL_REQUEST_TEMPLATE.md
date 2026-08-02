## What does this PR do?

<!-- Briefly describe the change and why it's needed -->

## Related issue(s)

<!-- Closes #123, if applicable -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Performance / Benchmark
- [ ] Packaging / CI
- [ ] Documentation
- [ ] Tests
- [ ] Other (please describe)

## Testing

<!-- How did you test this? Which platform(s)? Which HID device(s)? -->

**Rust (daemon, NM host, mock)**

- [ ] `cargo build --release` passes, if the change touches Rust code
- [ ] `npm run lint:rs` (cargo clippy) passes with no new warnings
- [ ] `npm run test:rs` passes
- [ ] Tested against a real HID device if the change touches enumeration,
      report descriptor parsing, or the data plane

**Addon (JS)**

- [ ] `npm run lint:js` and `npm run lint` (web-ext) pass
- [ ] `npm run test:browser` passes (no hardware needed)
- [ ] `npm run test:e2e` passes if the change touches the data plane or
      worker-spawn paths (see E2E setup note below)
- [ ] `npm run test:benchmark` if the change affects throughput or latency
- [ ] Manually tested the changed area in the browser

E2E needs the debug binaries and one-time Linux setup
(`sudo make install-e2e-udev-rule`); see
[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#testing). Running both e2e
projects concurrently requires `--workers=1`.

## Checklist

- [ ] I've read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] My commit messages follow Conventional Commits style
- [ ] I've updated relevant docs (README, DEVELOPMENT.md, ARCHITECTURE.md,
      BENCHMARK.md) if needed
