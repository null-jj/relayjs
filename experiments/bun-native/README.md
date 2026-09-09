# Bun native compatibility experiment

The compatibility patch preserves Linux OS file locking and passes Node/Bun
contention, release after graceful shutdown, release after process death,
invalid-descriptor errors, and synchronous/asynchronous extended-attribute checks.
A Node-API adapter now runs native work on background threads and delivers
completion on the environment thread; probes check JavaScript event-loop progress
and both queued and running cancellation.
With both rebuilt addons, Bun 1.4.2 passes registry initialization and independent
RocksDB write/read/close/reopen checks and all 18 storage/offline CLI tests.
Full peer acceptance still aborts on
`uv_interface_addresses` in the networking dependency.

Bun 1.3.14 passes the isolated locking and simple storage probes but crashes in
the offline persistence suite; use Bun 1.4.2 for these acceptance checks.

The CLI therefore continues to run on Node. Nothing in this experiment replaces
the installed native addon or disables locking.

## Run

Requires Linux, Bun 1.4.2 for the storage experiment, Node 22+, a C compiler (`cc`), Node development headers at
`/usr/include/node`, and libuv development headers at `/usr/include`. Install the
project dependencies with `bun install` first. The pinned `bare-compat-napi`
development dependency supplies the native compatibility headers.

```sh
# Prevent core dumps from the expected native aborts.
ulimit -c 0
bun run compat:bun --locking-only
bun run compat:bun
```

The default command builds TypeScript, copies dependencies into a temporary
directory, rebuilds the copied filesystem addon, checks native work and locking, checks Node
registry startup, and probes Bun registry and RocksDB in separate child processes.
After successful storage probes it runs the project regression suite under Bun
using a temporary CLI entry point.
It exits nonzero when storage integration fails; that failure must not be treated
as a successful runtime migration. `--locking-only` skips storage probes;
`--storage-only` includes storage and offline CLI tests but omits peer tests.

Override executable/header locations with `RELAY_BUN_BIN`, `RELAY_NODE_BIN`, `CC`,
`RELAY_NODE_INCLUDE`, and `RELAY_UV_INCLUDE`. For example:

```sh
RELAY_BUN_BIN=/path/to/bun bun run compat:bun
```

The harness dereferences dependency symlinks into private copies and validates
the compiler output location. It removes temporary files and terminates its own
children on completion, failure, SIGINT, or SIGTERM.

## Patch scope and remaining blocker

`posix-compat.h` replaces five synchronous libuv helpers for the isolated build:
`uv_get_osfhandle`, `uv_buf_init`, `uv_translate_sys_error`, `uv_err_name`, and
`uv_strerror`. Unix descriptors are already OS handles; buffer initialization and
error conversion need no event-loop operations. Error strings and names come from
the installed libuv header. The upstream `fcntl` locking implementation remains
unchanged. The harness requires `fs-native-extensions` 1.5.1 so dependency updates
force a review of this assumption.

`async-work.c` maps queueing and cancellation to `napi_create_async_work`,
`napi_queue_async_work`, and `napi_cancel_async_work`. It retains request data until
completion, uses private thread-local state per addon, and does not call JS from
the worker callback. This is a targeted adapter for these addons' environment
loop, not a general implementation of libuv.

## RocksDB source build

The separate RocksDB experiment builds the pinned native dependency in a temporary
copy, patches its librocksdb work scheduling, and checks write/read persistence
across close/reopen. It additionally requires CMake 4+, Ninja, Clang/Clang++ with C++20 support,
Git, Bash, `setsid`, and network access to fetch build dependencies and native
sources. Build it once and pass the artifact to the combined harness:

```sh
bun run compat:bun:rocksdb --output /tmp/relayjs-rocksdb-async.node
RELAY_ROCKSDB_ADDON=/tmp/relayjs-rocksdb-async.node bun run compat:bun --storage-only
# Includes peer transfers; currently fails on uv_interface_addresses.
RELAY_ROCKSDB_ADDON=/tmp/relayjs-rocksdb-async.node bun run compat:bun
```

The harness copies the supplied artifact only into its temporary dependency tree.
The build refuses to overwrite an existing output. Set `RELAY_NATIVE_JOBS` to
control compilation parallelism (default 2). `CC` and `CXX` override Clang; GCC 16
failed to compile the pinned native wrapper and binding during verification.

`rocksdb/posix-fs.h` additionally replaces the synchronous single-buffer filesystem
calls used inside the pinned wrapper's background work. It preserves errors and
file offsets, sets close-on-exec, and does not retry a possibly completed close.
Unsupported async or multi-buffer calls fail explicitly.

Without `RELAY_ROCKSDB_ADDON`, it probes the installed upstream RocksDB addon,
which still lacks the work-queue adapter.

## Abrupt Worker termination

The rebuilt filesystem addon can abort when a JS Worker is terminated with native
metadata requests pending. This also reproduces when rebuilding with the original
libuv queue, so it is not established as an adapter-only defect. Completion may
arrive with `napi_ok` before the binding marks itself as exiting. Assertions remain
enabled; the experiment does not hide this by suppressing native errors.

```sh
ulimit -c 0
bun run compat:bun --locking-only --worker-teardown
```

This diagnostic intentionally exits nonzero on the affected build. It must be
resolved before claiming general Worker support. Before enabling Bun as the CLI
runtime, storage and the full peer-transfer regression suite must pass as well.

## Verification recorded

- A clean Clang source build produced the addon and passed its Bun lifecycle probe.
- Bun 1.4.2: native file/work/cancellation/locking checks and 18 offline tests passed.
- Node: all 23 project regression tests passed after the snapshot cleanup fix.
- Full Bun peer acceptance: aborts on `uv_interface_addresses`.
- Abrupt Worker termination: diagnostic reproduces native cleanup assertions.

The local verified addon is generated at `dist/experiments/rocksdb-native.node`
(ignored by Git); build it again with `compat:bun:rocksdb --output` if absent.
Failed publication now waits for snapshot readers to close before deleting their
files, preventing the delayed-open error found during Bun verification.
