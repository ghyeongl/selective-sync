#!/bin/bash
set -e

TEST_DIR="${TEST_DIR:-/tmp/e2e-sync-test}"

# Archives/Spaces default to TEST_DIR children, but can be pointed at the
# production-shaped mount paths so staging matches pi1 exactly.
ARCHIVES_DIR="${E2E_ARCHIVES_DIR:-$TEST_DIR/Archives}"
SPACES_DIR="${E2E_SPACES_DIR:-$TEST_DIR/Spaces}"

# ── Create test data BEFORE server starts ──
# Clear the two target trees only. Never `rm -rf $TEST_DIR`: when the dirs are
# overridden, TEST_DIR can be a real mount root whose siblings must survive.
for d in "$ARCHIVES_DIR" "$SPACES_DIR"; do
  case "$d" in
    /|/srv|/home|"$HOME") echo "refusing to clear $d" >&2; exit 1 ;;
  esac
  # Not `rm -rf "$d/."` — rm refuses to remove '.' and silently skips, which
  # left Spaces populated across runs and made freshly seeded entries register
  # as synced. find -mindepth 1 empties the directory without touching it.
  mkdir -p "$d"
  find "$d" -mindepth 1 -delete
done
mkdir -p "$ARCHIVES_DIR/test-dir"

# 20 small files (1KB)
for i in $(seq 1 20); do
  dd if=/dev/zero of="$ARCHIVES_DIR/small-$i.txt" bs=1024 count=1 2>/dev/null
done

# 5 medium files (1MB)
for i in $(seq 1 5); do
  dd if=/dev/zero of="$ARCHIVES_DIR/medium-$i.dat" bs=1048576 count=1 2>/dev/null
done

# 1 large file (50MB)
echo "Creating 50MB test file..."
dd if=/dev/zero of="$ARCHIVES_DIR/large-file.dat" bs=1048576 count=50 2>/dev/null

# 1 giant file for copy-interruption tests.
#
# 256 MiB, not 1 GiB. pi3 copies at ~5.5 MB/s, so a 1 GiB fixture took 178-193s
# against poll windows of 120s and 180s — the group could not pass, and which
# tests tipped over varied with load. At 256 MiB a copy is ~48s, which still
# leaves ample room to interrupt while giving those windows 2.5-3.7x headroom.
#
# Keep in step with GIANT_BYTES in e2e/tests/copy-interrupt.spec.ts.
echo "Creating 256MiB test file..."
dd if=/dev/zero of="$ARCHIVES_DIR/giant-file.dat" bs=1048576 count=256 2>/dev/null

# 10 children in test-dir
for i in $(seq 1 10); do
  dd if=/dev/zero of="$ARCHIVES_DIR/test-dir/child-$i.txt" bs=1024 count=1 2>/dev/null
done

# Mass test files (optional — set MASS_FILE_COUNT to enable)
if [ -n "$MASS_FILE_COUNT" ] && [ "$MASS_FILE_COUNT" -gt 0 ] 2>/dev/null; then
  echo "Creating $MASS_FILE_COUNT mass test files..."
  MASS_DIR="$ARCHIVES_DIR/mass-test"
  mkdir -p "$MASS_DIR"
  for i in $(seq 0 $((MASS_FILE_COUNT - 1))); do
    printf 'x' > "$MASS_DIR/f-$i.txt"
  done
  echo "Mass test files created: $MASS_FILE_COUNT"
fi

echo "Test data ready: archives=$ARCHIVES_DIR spaces=$SPACES_DIR"

# ── Start server (exec replaces shell so signals propagate) ──
exec "$@"
