#!/bin/bash
# create-mass-files.sh — Generate 100K single-byte files for mass stress tests.
#
# Usage:
#   bash e2e/create-mass-files.sh [COUNT] [TEST_DIR]
#
# Defaults:
#   COUNT    = 100000  (100K files)
#   TEST_DIR = /tmp/e2e-sync-test
#
# Creates files at $TEST_DIR/Archives/mass-test/f-{0..N}.txt
# Each file is 1 byte ("x") to minimize I/O — we're testing entry count, not size.
#
# Performance (M2 Mac, APFS):
#   10K files  → ~2s
#   100K files → ~20s
set -e

COUNT="${1:-100000}"
TEST_DIR="${2:-/tmp/e2e-sync-test}"
MASS_DIR="$TEST_DIR/Archives/mass-test"

if [ -d "$MASS_DIR" ]; then
  EXISTING=$(ls -1 "$MASS_DIR" | wc -l | tr -d ' ')
  if [ "$EXISTING" -ge "$COUNT" ]; then
    echo "mass-test already has $EXISTING files (>= $COUNT). Skipping."
    exit 0
  fi
  echo "mass-test has $EXISTING files, need $COUNT. Regenerating..."
  rm -rf "$MASS_DIR"
fi

mkdir -p "$MASS_DIR"

echo "Creating $COUNT files in $MASS_DIR ..."
START=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')

# Use a loop with printf — faster than dd for 1-byte files
for i in $(seq 0 $((COUNT - 1))); do
  printf 'x' > "$MASS_DIR/f-$i.txt"
done

END=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
ELAPSED_MS=$(( (END - START) / 1000000 ))

ACTUAL=$(ls -1 "$MASS_DIR" | wc -l | tr -d ' ')
echo "Done: $ACTUAL files created in ${ELAPSED_MS}ms"
