#!/bin/bash
set -e

TEST_DIR="${TEST_DIR:-/tmp/e2e-sync-test}"

# ── Create test data BEFORE server starts ──
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/Archives/test-dir" "$TEST_DIR/Spaces"

# 20 small files (1KB)
for i in $(seq 1 20); do
  dd if=/dev/zero of="$TEST_DIR/Archives/small-$i.txt" bs=1024 count=1 2>/dev/null
done

# 5 medium files (1MB)
for i in $(seq 1 5); do
  dd if=/dev/zero of="$TEST_DIR/Archives/medium-$i.dat" bs=1048576 count=1 2>/dev/null
done

# 1 large file (50MB)
echo "Creating 50MB test file..."
dd if=/dev/zero of="$TEST_DIR/Archives/large-file.dat" bs=1048576 count=50 2>/dev/null

# 1 giant file (~1GB) for copy-interruption tests
echo "Creating 1GB test file..."
dd if=/dev/zero of="$TEST_DIR/Archives/giant-file.dat" bs=1048576 count=1024 2>/dev/null

# 10 children in test-dir
for i in $(seq 1 10); do
  dd if=/dev/zero of="$TEST_DIR/Archives/test-dir/child-$i.txt" bs=1024 count=1 2>/dev/null
done

# Mass test files (optional — set MASS_FILE_COUNT to enable)
if [ -n "$MASS_FILE_COUNT" ] && [ "$MASS_FILE_COUNT" -gt 0 ] 2>/dev/null; then
  echo "Creating $MASS_FILE_COUNT mass test files..."
  MASS_DIR="$TEST_DIR/Archives/mass-test"
  mkdir -p "$MASS_DIR"
  for i in $(seq 0 $((MASS_FILE_COUNT - 1))); do
    printf 'x' > "$MASS_DIR/f-$i.txt"
  done
  echo "Mass test files created: $MASS_FILE_COUNT"
fi

echo "Test data ready in $TEST_DIR"

# ── Start server (exec replaces shell so signals propagate) ──
exec "$@"
