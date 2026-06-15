#!/usr/bin/env bash
# Demo: mount-proof catches a silently-stale target before pixel-diff lies.
#
# Three runs:
#   1. baseline (v2) vs target (v3 with proof) → PASS, diff shows the styling change
#   2. baseline (v2) vs target-stale (v2, no proof) → MOUNT_PROOF_FAIL exit 5
#      Without mountproof this would be a SILENT GREEN PASS.
#
# Requirements: node ≥20, npx, and `npx playwright install chromium` ran once.

set -e

cd "$(dirname "$0")"

# Pick a static server. `npx serve` works; `python3 -m http.server` is fine too.
serve_dir() {
  local file=$1
  local port=$2
  # Use python's built-in static server — it honors the port arg reliably,
  # ships with every macOS / most Linux installs, and needs zero deps.
  local dir=$(mktemp -d)
  cp "$(pwd)/${file}" "${dir}/index.html"
  ( cd "${dir}" && python3 -m http.server "${port}" > /dev/null 2>&1 ) &
  echo $!
}

PORT_BASELINE=4501
PORT_TARGET=4502

echo "==> Starting baseline (v2) on :${PORT_BASELINE}, target (v3) on :${PORT_TARGET}…"
PID_BASE=$(serve_dir baseline.html "${PORT_BASELINE}")
PID_TGT=$(serve_dir target.html "${PORT_TARGET}")
sleep 1
trap "kill ${PID_BASE} ${PID_TGT} 2>/dev/null || true" EXIT

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "RUN 1 — Honest: baseline v2 vs target v3 (proof present on target)"
echo "════════════════════════════════════════════════════════════════════"
npx --yes @oleksiimazurenko/mountproof trajectory trajectory.json \
  --baseline "http://localhost:${PORT_BASELINE}" \
  --target "http://localhost:${PORT_TARGET}" \
  --out /tmp/mountproof-demo-honest || true

echo ""
echo "Now we simulate a STALE deploy on the target: v2 served from a URL"
echo "that's supposed to host v3. Pixel diff alone would say PASS (both"
echo "sides are identical). mountproof should fail before reaching diff."
echo ""

kill "${PID_TGT}" 2>/dev/null || true
sleep 0.5
PID_TGT=$(serve_dir target-stale.html "${PORT_TARGET}")
sleep 1
trap "kill ${PID_BASE} ${PID_TGT} 2>/dev/null || true" EXIT

echo "════════════════════════════════════════════════════════════════════"
echo "RUN 2 — Stale: target serves v2, no \`<style data-href='button_v3'>\`"
echo "════════════════════════════════════════════════════════════════════"
set +e
npx --yes @oleksiimazurenko/mountproof trajectory trajectory.json \
  --baseline "http://localhost:${PORT_BASELINE}" \
  --target "http://localhost:${PORT_TARGET}" \
  --out /tmp/mountproof-demo-stale
EXIT=$?
set -e
echo ""
echo "Exit code: ${EXIT} (expected 5 = MOUNT_PROOF_FAIL)"
echo ""
echo "Reports:"
echo "  file:///tmp/mountproof-demo-honest/report.html"
echo "  file:///tmp/mountproof-demo-stale/report.html"
