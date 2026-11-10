# Fork build and release

This repository builds a separate Passbolt multi-account browser extension and a matched web UI overlay. The extension never falls back to the upstream npm `passbolt-styleguide` package.

## Compatibility target

The frontend image retains the Passbolt CE 5.16 backend. Saved-account enrollment uses its TOTP readiness protocol; other MFA providers are not supported by this enrollment flow. An unverified import stays unsaved, and a pending TOTP import stays in extension session storage until the server confirms its user ID, email and key fingerprint after verification.

Backend URLs must use HTTPS, including migrated accounts. Saved-account switching takes two clicks inside the client while the selected account's unlock session remains valid. A new account and a login without remembering the passphrase use a 60-second unlock. The normal remember option retains that account's chosen timeout; switching does not extend it. Expiration requires the passphrase and any server-required MFA again, but does not require another private-key import.

## Pinned UI input

`passbolt-styleguide` is consumed from `file:vendor/passbolt-styleguide.tgz`. The generated tarball is ignored by Git and must be staged before `npm ci`.

`ui-pin.json` records the source repository, full styleguide commit SHA, package version, tarball SHA-256, and npm integrity. `package-lock.json` records the same tarball integrity. This means a missing, replaced, or stale tarball fails installation and build verification.

The release tarball is generated from the styleguide repository by:

```sh
npm run pack:fork -- --out <artifact-directory> --require-clean --require-pinned-toolchain
```

The build uses `SOURCE_DATE_EPOCH` from the source commit for generated LESS metadata. Release artifacts must be built with Node 22.14.0 and npm 10.9.2. `scripts/with-release-toolchain.sh` runs npm in an isolated temporary toolchain, so no global Node runtime is changed.

## Bootstrap a fresh clone

Before the final UI pin is published, the `ui-pin.json` values are deliberately marked pending and release builds fail closed.

After the final UI commit exists, use a clean adjacent styleguide checkout:

```sh
# Both commands use the isolated release toolchain.
npm run ui:pin
npm ci
```

`npm run ui:pin` builds the clean styleguide tarball, creates a temporary detached worktree from that commit, runs a second `npm ci` and tarball build there, and only writes the pin if both tarballs are byte-identical. It then stages the verified tarball and updates `package-lock.json`.

For another checkout, regenerate the ignored vendor tarball from the committed pin before installing:

```sh
npm run ui:bootstrap
npm ci
```

`npm ci` by itself cannot resolve `vendor/passbolt-styleguide.tgz` in a fresh checkout. This bootstrap requirement is intentional: the build must either verify the pinned fork tarball or fail.

## Local acceptance before committing

Local integration testing uses a mutable working-tree tarball and never writes `ui-pin.json`:

```sh
npm run ui:local -- --exclusive
```

Useful options:

```sh
npm run ui:local -- --exclusive --checks
npm run ui:local -- --exclusive --docker
npm run ui:local -- --exclusive --source ../passbolt_styleguide --checks --docker
```

`--exclusive` is required because the command replaces extension `node_modules`. Coordinate with every other runtime/UI build or test process first.

The local command:

- builds the current styleguide working tree;
- records the artifact as `localOnly` in ignored `dist/ui-local/`;
- stages the tarball temporarily;
- transactionally updates and then restores `package-lock.json`, refusing to overwrite a lockfile changed by another writer;
- runs `npm ci` and `npm run release:build`;
- optionally runs lint, unit tests, and a Docker image build/verification;
- does not alter `ui-pin.json` and cannot satisfy CI release verification.

Signals and errors trigger lockfile restoration. The last pre-local lockfile remains at `dist/ui-local/package-lock.before.json` as a recovery backup.

## Freeze the verified UI

1. Commit and verify the final styleguide source.
2. Return to the extension repository and run `npm run ui:pin`.
3. Commit `ui-pin.json` and `package-lock.json` with the integrated extension changes.
4. Run a final clean release build in CI or with the pinned toolchain.

The workflow logic reads `ui-pin.json`; it does not need editing for the next UI commit.

## CI and downloadable artifacts

`.github/workflows/fork-build-release.yml` runs on fork branches, pull requests, `fork-v*` tags, and manual dispatch. It:

1. checks the full UI commit out from `ui-pin.json`;
2. builds the styleguide tarball with the pinned toolchain;
3. verifies the rebuilt tarball SHA-256 and integrity against `ui-pin.json`;
4. installs the extension from the verified vendor tarball;
5. runs lint, unit tests, browser builds, and a Docker image verification;
6. uploads a downloadable artifact bundle.

Tag builds and manual dispatches with `publish_release=true` attach the bundle to a GitHub release. The bundle contains:

- Chromium MV3 developer ZIP;
- unsigned Firefox developer ZIP;
- matched web UI asset archive;
- the exact styleguide tarball;
- `BUILD-MANIFEST.json`, `RELEASE_NOTES.md`, `SHA256SUMS`, and Docker frontend metadata.

### Chromium

Extract the Chromium ZIP, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. The manifest carries a stable public key for extension ID `ibkcmmjpbjkangebjmfominbhihgnmld`. No upstream update URL is included.

### Firefox

The unsigned ZIP is only for temporary development loading through `about:debugging#/runtime/this-firefox`. It is not a normal persistent Firefox install.

Optional CI signing uses the unlisted Mozilla Add-ons channel with repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. A signed XPI is attached only when `web-ext sign` exits successfully. The fork add-on ID is `passbolt-multi-account@type-delta.github.io`.

No store credentials are created or stored by this repository.

## Remaining compatibility proof

These artifacts prove packaging and source matching. They do not by themselves prove Passbolt 5.17.x client compatibility with a stock Passbolt 5.16.0 backend. That requires the integrated browser and server-asset acceptance flow against disposable stock backends.
