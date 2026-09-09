#!/usr/bin/env bash
set -euo pipefail

# Builds a private rocksdb-native Node-API artifact and runs the Bun storage
# lifecycle probe. It never writes the project's node_modules or Bun cache.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
bun_bin=${RELAY_BUN_BIN:-bun}
node_include=${RELAY_NODE_INCLUDE:-/usr/include/node}
uv_include=${RELAY_UV_INCLUDE:-/usr/include}
# GCC 16 cannot instantiate libjstl's Node-API function marshaller here, and
# the pinned librocksdb wrapper also uses a designated-initializer order GCC
# rejects. Clang builds both pinned sources; callers may explicitly override.
c_compiler=${CC:-clang}
cxx_compiler=${CXX:-clang++}
jobs=${RELAY_NATIVE_JOBS:-2}
child=
artifact=
artifact_temp=

usage() {
  echo "Usage: $0 [--output /absolute/path/to/rocksdb-native.node]" >&2
}

while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || { usage; exit 2; }
      artifact=$2
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -n "$artifact" ]]; then
  case "$artifact" in
    /*) ;;
    *) echo '--output must be an absolute path' >&2; exit 2 ;;
  esac
  [[ ! -L "$artifact" ]] || { echo '--output must not be a symlink' >&2; exit 2; }
  artifact=$(realpath -m "$artifact")
  case "$artifact" in "$root"/node_modules/*) echo '--output must not write installed dependencies' >&2; exit 2 ;; esac
  mkdir -p "$(dirname "$artifact")"
  artifact="$(realpath "$(dirname "$artifact")")/$(basename "$artifact")"
  [[ ! -e "$artifact" && ! -L "$artifact" ]] || { echo '--output already exists' >&2; exit 2; }
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/relayjs-rocksdb-native-XXXXXX")

cleanup() {
  status=$?
  if [[ -n "$child" ]]; then
    kill -TERM -- "-$child" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$child" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [[ ${RELAY_ROCKSDB_KEEP_WORK:-} == 1 ]]; then
    echo "Kept build workspace: $work" >&2
  else
    [[ -d "$work" ]] && rm -rf -- "$work"
  fi
  [[ -n "$artifact_temp" ]] && rm -f -- "$artifact_temp"
  exit "$status"
}
run() {
  setsid "$@" &
  child=$!
  wait "$child"
  child=
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

test -f "$node_include/node_api.h"
test -f "$uv_include/uv.h"
command -v cmake >/dev/null
command -v "$bun_bin" >/dev/null
command -v "$c_compiler" >/dev/null
command -v "$cxx_compiler" >/dev/null
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'RELAY_NATIVE_JOBS must be a positive integer' >&2; exit 2; }
[[ $(node -p "require(process.argv[1]).version" "$root/node_modules/rocksdb-native/package.json") == 3.17.4 ]] || {
  echo 'Expected rocksdb-native 3.17.4; review the patch before updating' >&2
  exit 1
}

mkdir -p "$work/addon"
cp -RL "$root/node_modules/rocksdb-native/." "$work/addon/"
run "$bun_bin" add --cwd "$work/addon" --cache-dir "$work/bun-cache" --dev --exact --ignore-scripts \
  cmake-bare@1.1.14 cmake-fetch@1.5.3 cmake-napi@1.3.0 cmake-npm@1.1.2 \
  bare-compat-napi@1.3.8
cp "$root/experiments/bun-native/async-work.c" "$work/addon/"
cp "$root/experiments/bun-native/async-work.h" "$work/addon/"
patch -d "$work/addon" -p1 < "$root/experiments/bun-native/rocksdb/rocksdb-native.patch"

run cmake -S "$work/addon" -B "$work/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="$c_compiler" \
  -DCMAKE_CXX_COMPILER="$cxx_compiler" \
  -DCMAKE_CXX_STANDARD=20 \
  -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
  -DCMAKE_C_FLAGS="-I$node_include -I$uv_include -include $root/experiments/bun-native/posix-compat.h -include $root/experiments/bun-native/rocksdb/posix-fs.h" \
  -DCMAKE_CXX_FLAGS="-I$node_include -I$uv_include -include $root/experiments/bun-native/posix-compat.h -include $root/experiments/bun-native/rocksdb/posix-fs.h"
run cmake --build "$work/build" --target rocksdb-native.node --parallel "$jobs"

output=$(find "$work/build" -type f -name 'rocksdb-native.node' -print -quit)
test -n "$output"
mkdir -p "$work/probe/node_modules"
cp -RL "$root/node_modules/." "$work/probe/node_modules/"
cp "$output" "$work/probe/node_modules/rocksdb-native/prebuilds/linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/rocksdb-native.node"
cp "$root/experiments/bun-native/fixtures/rocksdb.mjs" "$work/probe/rocksdb.mjs"
run timeout --kill-after=5s 30s "$bun_bin" "$work/probe/rocksdb.mjs" "$work/probe/data"

if [[ -n "$artifact" ]]; then
  artifact_temp=$(mktemp "${artifact}.tmp.XXXXXX")
  cp "$output" "$artifact_temp"
  if ! ln -T "$artifact_temp" "$artifact"; then
    echo '--output was created while building; artifact not published' >&2
    exit 1
  fi
  rm -f -- "$artifact_temp"
  artifact_temp=
  echo "Built Bun-compatible RocksDB addon: $artifact"
fi
