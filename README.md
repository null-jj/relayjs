# relayjs

**relayjs** is a private artifact registry with the **`relay` CLI**: publish a named file version, fetch and verify it on a trusted device, and keep it available through a replica after the publisher disconnects.

Use Bun 1.3.14+ for package management and project commands. The prototype is written in strict TypeScript and runs on Node.js 22+ using Pear's Hyperdrive, Corestore, and Hyperswarm ecosystem. It is not yet packaged for the Pear/Bare runtime.

```sh
bun install --frozen-lockfile
bun run dev --help
bun run test
```

See the [CLI guide](docs/artifact-cli.md) for a two-device walkthrough and [architecture decision](decisions/0001-private-artifact-cli.md) for boundaries, data model, and trust assumptions.

## Install the CLI

For a packaged release, follow the [release installation guide](docs/releases.md).
Development happens on `main`; production releases come from `production`.
For development from a checkout:

```sh
bun run dev --help
bun run dev init
```

`bun run dev` uses `.relayjs/development` for registry state. The installed
production `relay` uses `~/.pear-artifact` by default. See the
[development and production guide](docs/releases.md#development-and-production).

## Publish and seed your first artifact

Run these in order, replacing `./my-app.zip` with an existing file you want to share:

```sh
bun run dev init
bun run dev publish ./my-app.zip --name app --version 1.0
bun run dev seed app@1.0
```

`app@1.0` names the artifact published by the second command; it is not a built-in example. Seeding stays running until Ctrl+C.

To receive an existing registry instead, use `bun run dev join REGISTRY_KEY` and exchange device trust with its publisher; see the [CLI guide](docs/artifact-cli.md). If your registry already lives in a custom directory, pass `--store PATH` to each command instead of initializing a new default registry.

## Verification

```sh
bun run check
bun run test
```

This is a technical prototype with one publisher per registry and whole-registry device trust. Local state is not encrypted at rest.

## Packaging and releases

Run `bun run package` to create an installable tarball and checksum, then
`bun run package:check` to verify it in a fresh installation. Matching `v*` tags on production history
trigger tested GitHub Releases; see the [release guide](docs/releases.md).

## Bun runtime limitation

Bun manages dependencies, the lockfile, and project commands. The `relay` executable and regression tests still run on Node.js. Running registry initialization directly with Bun 1.3.14 or 1.4.2 on Linux crashes in `fs-native-extensions` because Bun does not implement `uv_get_osfhandle`. File locking remains enabled. An isolated native adapter now passes locking, registry startup, and RocksDB persistence checks under Bun 1.4.2. Full peer transfers remain blocked by `uv_interface_addresses` in the networking dependency; abrupt Worker termination also exposes a native cleanup failure.

Use `bun run dev seed app@1.0` or the linked `relay` executable. Full Bun runtime support requires resolving the native compatibility issue; switching the test runner to `bun test` does not resolve it. See the [native compatibility experiment](experiments/bun-native/README.md) for reproduction commands and [Bun's libuv tracking issue](https://github.com/oven-sh/bun/issues/18546).
