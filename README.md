# relayjs

**relayjs** is a private artifact registry with the **`relay` CLI**: publish a named file version, fetch and verify it on a trusted device, and keep it available through a replica after the publisher disconnects.

The prototype runs on Node.js 22+ using Pear's Hyperdrive, Corestore, and Hyperswarm ecosystem. It is not yet packaged for the Pear/Bare runtime.

```sh
npm ci
node bin/relay.js --help
npm test
```

See the [CLI guide](docs/artifact-cli.md) for a two-device walkthrough and [architecture decision](decisions/0001-private-artifact-cli.md) for boundaries, data model, and trust assumptions.

## Install the CLI

```sh
npm link
relay --help
relay seed app@1.0
```

Initialize a registry and publish or fetch an artifact before seeding it; see the CLI guide for the full workflow.

## Verification

```sh
npm run check
npm test
```

This is a technical prototype with one publisher per registry and whole-registry device trust. Local state is not encrypted at rest.
