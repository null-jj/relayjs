# relayjs CLI guide

This technical prototype distributes single files between explicitly trusted devices. Archive a directory yourself before publishing. It never installs or executes downloaded artifacts.

## Setup

Install Bun 1.3.14+ and Node.js 22+. Bun handles installation and project commands; Node.js runs the CLI because its native file-locking dependency crashes under the tested Bun runtimes:

```sh
bun install --frozen-lockfile
bun run relay --help
```

The package defines a dedicated executable named `relay`. You can run `bun run relay --help` after building, or install the command from this checkout:

```sh
bun link
relay --help
```

Linking is optional and changes your local Bun executable directory; no npm package needs to be published. To remove the link later, run `bun unlink`.

`bun install --frozen-lockfile` runs the TypeScript build automatically. After editing `.ts` files, run `bun run build` to refresh `dist/`. `bun run check` typechecks without emitting files; `bun run test` builds and runs the existing JavaScript regression tests against the compiled application.

Commands print JSON to stdout. Errors go to stderr with a nonzero exit code. `--store` selects a local state directory; the default is `~/.pear-artifact`. The existing default directory is retained so the rename does not hide previously initialized registries. Keep each device's state separate. Never share the publisher's entire state directory as an invitation: it contains private signing keys.

## First-run setup

`seed NAME@VERSION` requires an initialized or joined registry. To publish your own file in the default store:

```sh
bun run relay init
bun run relay publish ./my-app.zip --name app --version 1.0
bun run relay seed app@1.0
```

Replace `./my-app.zip` with an existing file. If you are receiving another publisher's artifact, join their registry and establish mutual device trust as shown below. If the registry was created with `--store`, use that same option for subsequent commands. A missing registry error does not mean you should overwrite or recreate an existing store elsewhere.

## Two-device walkthrough

On the publishing machine:

```sh
node dist/bin/relay.js init --store ./publisher
node dist/bin/relay.js publish ./my-app.zip --name my-app --version 1.0.0 --store ./publisher
```

The initialization result contains `registryKey` and the publisher device's `identity`. Exchange these public keys through a trusted channel. On the receiving machine, replace `REGISTRY_KEY` with that value:

```sh
node dist/bin/relay.js join REGISTRY_KEY --store ./reader
```

The reader prints its own `identity`. Both machines must authorize the other's device identity, replacing the placeholders:

```sh
# Publisher machine
node dist/bin/relay.js trust READER_IDENTITY --store ./publisher

# Reader machine
node dist/bin/relay.js trust PUBLISHER_IDENTITY --store ./reader
```

Keep the publisher online with this long-running command:

```sh
node dist/bin/relay.js seed --store ./publisher
```

Then fetch from the receiving machine:

```sh
node dist/bin/relay.js fetch my-app@1.0.0 --output ./downloads/my-app.zip --store ./reader --timeout 30000
```

The output appears only after its length and SHA-256 are verified. Existing output files are refused. The downloaded blocks remain cached, so another fetch to a different output path can work after the publisher goes offline.

## Serve from a replica

After fetching, the reader can serve its cached copy:

```sh
node dist/bin/relay.js seed my-app@1.0.0 --store ./reader
```

To prove publisher-independent availability, join a third device using the same registry key. Exchange trust between that device and the reader before starting their seed/fetch commands. Stop the publisher's seed process, then fetch on the third device. The third device needs no publisher connection when the reader has the required data.

`seed NAME@VERSION` first downloads/verifies that artifact and then stays online. `seed` without a reference serves only blocks already present. Stop seeding with Ctrl+C. A state directory is exclusively used by its running process; stop seeding before publishing another version or changing trust in that same directory.

## Other commands

```sh
node dist/bin/relay.js identity --store ./reader
node dist/bin/relay.js list --store ./reader
node dist/bin/relay.js untrust PEER_IDENTITY --store ./reader
```

`list` requests fresh registry metadata. On a reader, it may time out if no trusted source is reachable, even if individual artifacts are cached. Fetching an already cached exact version does not require that refresh.

Removing trust blocks future direct replication with that identity after the configuration is used. It cannot erase previously received files or prevent other trusted peers from serving them.

## Networking and failure handling

- Fetch and initial mirror operations default to a 15-second deadline. Increase it for large files using `--timeout MILLISECONDS`.
- A timeout may mean no source is online, trust is missing on either side, a network blocks the connection, or the transfer needs more time. It does not prove that an artifact does not exist.
- Retry reuses verified Hypercore blocks already cached; the temporary exported output starts over.
- Metadata reflects the peers reached so far, not a guaranteed latest global view. If a newly published version is missing while peers are still connecting, retry once a current source is reachable.
- Hyperswarm uses public DHT bootstrap nodes by default. `--bootstrap HOST:PORT` can be repeated or comma-separated for a prepared private DHT. An arbitrary peer address is not necessarily a bootstrap node.
- A fresh reader needs metadata as well as blob contents. Seeding an app bundle with the Pear CLI is separate from seeding this registry's artifact data.

## Limits

This is a Node CLI using Pear ecosystem libraries, not a Pear/Bare application bundle. It currently has one publisher per registry, whole-registry device trust, and no encrypted local vault, individual-user accounts, revocation of copies, release channels, npm compatibility, or managed availability service. Keep local state outside the checkout or in ignored directories. No cloud service or development server is required.

```sh
bun run check
bun run test
```

Use `bun run test` for the supported regression suite, which runs on Node.js. Direct execution with Bun is intentionally rejected with a clear error instead of reaching the native file-locking crash confirmed on Bun 1.3.14 and 1.4.2 (Linux).
