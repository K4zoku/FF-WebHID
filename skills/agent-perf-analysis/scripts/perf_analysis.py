#!/usr/bin/env python3
"""
perf_analysis.py — click-to-paint latency + GCMajor counter for
Firefox Profiler + Chromium DevTools exports.

Directory layout (mandatory):
    <bench_dir>/
        chromium/run-{1..5}.json   # DevTools Performance exports
        <modeA>/run-{1..5}.json    # Firefox Profiler exports
        <modeB>/run-{1..5}.json    # Firefox Profiler exports

Output: stdout table with median, min, max, p90, GC count per run.

Usage:
    python3 perf_analysis.py <bench_dir>
"""

from __future__ import annotations
import json
import statistics
import sys
from pathlib import Path


# --- Firefox Profiler parser -------------------------------------------------

def _fx_click_to_paint(profile: dict) -> tuple[float, int]:
    """Return (latency_ms, gc_major_count) for one Firefox Profiler export."""
    threads = profile.get("threads", [])
    if not threads:
        raise ValueError("no threads in Firefox profile")

    main = next((t for t in threads if "GeckoMain" in t.get("name", "")), threads[0])
    markers = main.get("markers", {})

    # Find pointerdown marker (DOMEvent with eventType=pointerdown).
    pd_ts = None
    string_array = markers.get("stringArray", [])
    marker_data = markers.get("data", [])
    for i in range(len(string_array)):
        if string_array[i] != "DOMEvent":
            continue
        entry = marker_data[i] if i < len(marker_data) else None
        if isinstance(entry, dict) and entry.get("eventType") == "pointerdown":
            pd_ts = markers["time"][i]
            break
    if pd_ts is None:
        # Fallback: UserTiming marker named "click-start".
        for i in range(len(string_array)):
            if string_array[i] == "click-start":
                pd_ts = markers["time"][i]
                break
    if pd_ts is None:
        raise ValueError("pointerdown marker not found; did the click register?")

    # Walk all threads; collect Paint timestamps in window.
    paint_times: list[int] = []
    for thread in threads:
        t_markers = thread.get("markers", {})
        t_strings = t_markers.get("stringArray", [])
        t_times = t_markers.get("time", [])
        for i in range(len(t_strings)):
            if t_strings[i] == "Paint":
                ts = t_times[i]
                if pd_ts <= ts <= pd_ts + 5_000_000:  # microseconds
                    paint_times.append(ts)
    if not paint_times:
        raise ValueError("no Paint events in 5s window after pointerdown")
    last_paint = max(paint_times)

    latency_ms = (last_paint - pd_ts) / 1000.0  # us → ms

    # Count GCMajor markers across all threads (in-window only).
    gc_count = 0
    for thread in threads:
        t_markers = thread.get("markers", {})
        t_data = t_markers.get("data", [])
        t_times = t_markers.get("time", [])
        for i in range(len(t_data)):
            payload = t_data[i]
            if not isinstance(payload, dict):
                continue
            if payload.get("type") == "GCMajor" or payload.get("phase") == "MajorGC":
                ts = t_times[i] if i < len(t_times) else 0
                if pd_ts <= ts <= pd_ts + 5_000_000:
                    gc_count += 1

    return latency_ms, gc_count


# --- Chromium DevTools parser ------------------------------------------------

def _cr_click_to_paint(trace_events: list[dict]) -> tuple[float, int]:
    """Return (latency_ms, gc_count) for one Chromium DevTools export."""
    pd_ts = None
    for ev in trace_events:
        if ev.get("name") == "EventDispatch" and \
           ev.get("args", {}).get("data", {}).get("type") == "pointerdown":
            pd_ts = ev["ts"]
            break
    if pd_ts is None:
        raise ValueError("pointerdown EventDispatch not found")
    end_window = pd_ts + 5_000_000  # 5s in microseconds

    last_paint = None
    gc_count = 0
    for ev in trace_events:
        ts = ev.get("ts", 0)
        if not (pd_ts <= ts <= end_window):
            continue
        name = ev.get("name", "")
        phase = ev.get("ph", "")
        if name in ("Paint", "LayerTreeHost::UpdateLayerTree") and phase in ("X", "R"):
            if last_paint is None or ts > last_paint:
                last_paint = ts
        if name in ("MajorGC", "V8.GCScavenger") and phase in ("X", "R"):
            gc_count += 1

    if last_paint is None:
        raise ValueError("no Paint event in 5s window after pointerdown")
    return (last_paint - pd_ts) / 1000.0, gc_count


# --- Driver ------------------------------------------------------------------

def _load_run(path: Path) -> tuple[float, int]:
    data = json.loads(path.read_text())
    # Heuristic: Firefox Profiler has top-level "threads";
    # DevTools has "traceEvents".
    if "traceEvents" in data:
        return _cr_click_to_paint(data["traceEvents"])
    return _fx_click_to_paint(data)


def _summarise(mode: str, runs: list[tuple[float, int]]) -> dict:
    latencies = sorted(r[0] for r in runs)
    gc_counts = [r[1] for r in runs]
    n = len(latencies)
    p90 = latencies[int(0.9 * (n - 1))] if n else 0.0
    return {
        "mode": mode,
        "n": n,
        "median_ms": statistics.median(latencies) if latencies else 0.0,
        "min_ms": latencies[0] if latencies else 0.0,
        "max_ms": latencies[-1] if latencies else 0.0,
        "p90_ms": p90,
        "gc_total": sum(gc_counts),
        "gc_per_run": gc_counts,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 1
    bench_dir = Path(argv[1])
    if not bench_dir.is_dir():
        print(f"error: {bench_dir} is not a directory", file=sys.stderr)
        return 2

    summaries: list[dict] = []
    for mode_dir in sorted(p for p in bench_dir.iterdir() if p.is_dir()):
        run_files = sorted(mode_dir.glob("run-*.json"))
        if not run_files:
            continue
        runs: list[tuple[float, int]] = []
        for rf in run_files:
            try:
                runs.append(_load_run(rf))
            except Exception as e:
                print(f"[warn] {mode_dir.name}/{rf.name}: {e}", file=sys.stderr)
        if runs:
            summaries.append(_summarise(mode_dir.name, runs))

    if not summaries:
        print("no usable runs found", file=sys.stderr)
        return 3

    # Print table.
    hdr = f"{'mode':<14}{'n':>3}{'median':>11}{'min':>10}{'max':>10}{'p90':>11}{'gc':>5}"
    print(hdr)
    print("-" * len(hdr))
    for s in summaries:
        print(f"{s['mode']:<14}{s['n']:>3}"
              f"{s['median_ms']:>10.1f}ms"
              f"{s['min_ms']:>9.1f}ms"
              f"{s['max_ms']:>9.1f}ms"
              f"{s['p90_ms']:>10.1f}ms"
              f"{s['gc_total']:>5}")
    print()
    for s in summaries:
        print(f"  {s['mode']:<12} gc_per_run = {s['gc_per_run']}")

    # Delta vs first mode (assumed baseline, usually 'chromium').
    if len(summaries) >= 2:
        base = summaries[0]
        print()
        print(f"Δ vs {base['mode']} (median {base['median_ms']:.1f}ms):")
        for s in summaries[1:]:
            delta = s["median_ms"] - base["median_ms"]
            pct = (delta / base["median_ms"] * 100.0) if base["median_ms"] else 0.0
            print(f"  {s['mode']:<12} {delta:+.1f}ms ({pct:+.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
