#!/usr/bin/env bash
# Headless launcher keyboard/a11y full-loop test (no window, no OS access).
# Builds app/harness against the installed Native SDK and runs keys_test.zig.
# Usage: scripts/harness-test.sh   (from anywhere; needs `native` and zig 0.16)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
harness="$repo/app/harness"
native_bin="$(command -v native)"
sdk="$(cd "$(dirname "$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$native_bin")")/.." && pwd)"
rel="$(node -e 'console.log(require("path").relative(process.argv[1], process.argv[2]))' "$harness" "$sdk")"
cat > "$harness/build.zig.zon" <<ZON
.{
    .name = .bettercast_harness,
    .fingerprint = 0x557eb7465419235,
    .version = "0.1.0",
    .minimum_zig_version = "0.16.0",
    .dependencies = .{ .native_sdk = .{ .path = "$rel" } },
    .paths = .{ "build.zig", "build.zig.zon", "keys_test.zig" },
}
ZON
cd "$harness"
zig build keys-test "$@"
exec ./zig-out/bin/keys-test
