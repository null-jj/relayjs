# Packaging and releases

relayjs is distributed as an installable `.tgz` package on GitHub Releases. The
repository is public, so published releases and their assets are public. The npm
manifest remains `private: true`: this workflow does not publish to npm.

The package contains compiled TypeScript output, documentation, and runtime
package metadata. Installers fetch native dependencies for the target machine.
It requires Node.js 22+; this is not a standalone executable or a Bun runtime
build. Experimental native patches, development tools, and local registry data
are excluded. Packaged consumers do not run the repository's build scripts.

## Build and verify locally

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run package
bun run package:check
```

For version `0.1.0`, the output is `artifacts/relayjs-0.1.0.tgz` plus
`artifacts/relayjs-0.1.0.tgz.sha256`. These generated files are ignored by Git.

The package check verifies the checksum, installs the tarball in a temporary
project with production dependencies, invokes the installed `relay` command, and
checks native registry initialization, binary publication/fetch, and refusal to
overwrite an existing file. Its registry and bootstrap address are isolated from
user data. Temporary installation files are removed afterward.

## Install a release

After a release has been published, download its tarball and checksum from the
repository's Releases page, or use GitHub CLI:

```sh
gh release download v0.1.0 --repo null-jj/relayjs \
  --pattern 'relayjs-0.1.0.tgz' --pattern 'relayjs-0.1.0.tgz.sha256'
sha256sum --check relayjs-0.1.0.tgz.sha256
bun add --global ./relayjs-0.1.0.tgz
relay --help
```

On macOS, use `shasum -a 256 -c relayjs-0.1.0.tgz.sha256` for verification.
Node.js must be on `PATH`. To uninstall, run `bun remove --global relayjs`.
Global installation and removal are user actions; the local verification script
uses a temporary project instead.

## Development and production

| Setup | Branch | Command | Default registry | Distribution |
| --- | --- | --- | --- | --- |
| Development | `main` | `bun run dev <command>` | `.relayjs/development` | CI tarball artifacts |
| Production | `production` | installed `relay <command>` | `~/.pear-artifact` | Tagged GitHub Releases |

Development commands build the current TypeScript before running. For example:

```sh
bun install --frozen-lockfile
bun run dev init
bun run dev publish ./build.zip --name app --version 1
bun run dev seed app@1
```

Development state is ignored by Git. Production uses the packaged CLI; a source
checkout can run `bun run build` followed by `bun run start <command>` to execute
the compiled production entry point. The `RELAY_STORE` environment variable selects a default registry; `--store PATH`
takes precedence. The development script sets `RELAY_STORE` explicitly.
Never point development commands at a production store when trying changes.

Initialize the production branch from a reviewed development commit when ready:

```sh
git switch main
git switch -c production
git push -u origin production
```

For subsequent promotions, merge reviewed development changes into `production`.
Both branches run the verification workflow. Only tags on commits already in
production history can publish; a tag on an unpromoted development commit fails.
The release job uses the GitHub `production` environment. Repository environment
rules, if configured, apply to that job.

## Cut a release

1. Update `version` in `package.json` (for example `0.1.1` or `0.2.0-rc.1`), then
   run `bun install --lockfile-only` and the local checks above.
2. Commit the version change on `main`, then promote the reviewed commit to
   `production` and push that branch.
3. From `production`, create and push a matching tag:

   ```sh
   git switch production
   git tag -a v0.1.1 -m 'relayjs v0.1.1'
   git push origin v0.1.1
   ```

The workflow checks that the tag exactly matches the package version and points
to a commit in production history. It runs
project tests, packages once, and installs that same tarball on Linux and macOS
with Node 22 and 24. Only after every job passes does it create a GitHub Release
with the tarball, SHA-256 checksum, and generated release notes. Versions with a
prerelease suffix are marked as prereleases and do not replace the latest release.

Pushes to `main` or `production`, pull requests, and manual workflow runs perform verification
and retain downloadable workflow artifacts, but do not publish a release. No npm
token is needed; only the release job receives `contents: write` permission.

An existing release is never overwritten by a rerun. If a release upload fails
partway through, inspect the existing release or draft and its assets before
retrying. Correct an incomplete draft explicitly; use a new version for changes
to an already published release.

Windows installation is not covered by this initial release matrix. The CLI
continues to use Node because full Bun peer networking is still unsupported.
