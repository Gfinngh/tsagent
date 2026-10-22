#!/usr/bin/env bash
# Run every verify:* script independently and capture all output to a
# single file. Unlike `npm run verify:all`, this does NOT stop at the
# first failure — we want to see every failing script in one pass.
#
# Usage:
#   bash scripts/run_all_verify.sh
# Output:
#   verify-report.txt  (in project root)

set -uo pipefail

OUT="verify-report.txt"
: > "$OUT"

run() {
  local label="$1"
  shift
  echo "" >> "$OUT"
  echo "================================================================" >> "$OUT"
  echo ">>> $label" >> "$OUT"
  echo "================================================================" >> "$OUT"
  "$@" >> "$OUT" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then
    echo "<<< $label: PASS (exit $code)" >> "$OUT"
  else
    echo "<<< $label: FAIL (exit $code)" >> "$OUT"
  fi
  return $code
}

# Collect all verify:* script names in a stable order.
mapfile -t SCRIPTS < <(
  node -e '
    const s = require("./package.json").scripts;
    Object.keys(s)
      .filter((k) => k.startsWith("verify:") && k !== "verify:all")
      .sort()
      .forEach((k) => console.log(k));
  '
)

echo "Running typecheck..." >&2
run "typecheck" npm run typecheck

for name in "${SCRIPTS[@]}"; do
  echo "Running $name..." >&2
  run "$name" npm run "$name" || true
done

# Summary
echo "" >> "$OUT"
echo "================================================================" >> "$OUT"
echo ">>> SUMMARY" >> "$OUT"
echo "================================================================" >> "$OUT"
grep -E '^<<< ' "$OUT" >> "$OUT" 2>/dev/null || true

echo ""
echo "Done. Full output: $(pwd)/$OUT"
echo "Show summary lines:"
grep -E '^<<< ' "$OUT" || true