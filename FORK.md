# passbolt_browser_extension Fork

<!-- In-synced fork: maintained with the `syncfork` skill. -->

This fork adds isolated saved accounts to the Passbolt browser extension: switch between self-hosted Passbolt accounts without re-importing keys, enroll an account from a full extension tab, and ship the extension with a matched, revisioned server frontend that is built and verified from an immutable base image. It tracks `passbolt/passbolt_browser_extension` `master`. The `base` tag records the upstream fork/sync point.

## Divergence Log

Each behavior where this fork differs from upstream has one entry here. If you change code in this repository, check if this log needs an update.

The rules:

- Update the entry that owns the behavior you changed, or add an entry with the next unused ID. One entry covers one behavior, not one commit.
- Describe the current behavior, why the fork needs it, and how it composes with upstream's related behavior. When the behavior changes, rewrite the entry. Do not append a changelog; git and the Merge History hold history.
- Under **Implementation evidence**, list the key source files and tests. Under **Recorded validation**, list the checks that proved the current behavior.
- Set **Last updated** to today's date on every entry you touch.
- Never reuse an ID. Retire an entry only with the user's explicit approval: delete it and name the retired ID in the next Merge History entry.
- When an ID conflicts from merges, renumber the IDs as needed.
- A change that does not alter how the fork differs from upstream (formatting, or an edit to this file) needs no entry.

### DL001 — Saved-account registry and account switching

Upstream stores exactly one account in the legacy account projection. This fork keeps a saved-account registry containing encrypted private keys in `browser.storage.local` under its own versioned key, written behind a `navigator.locks` lock, and a separate public saved-server registry. A server base URL must be HTTPS with no credentials, query or fragment, and is normalized to one canonical form so the same deployment cannot be saved twice. Only an encrypted private key that matches its public key is accepted. Account records are migrated into the legacy account projection on use, and `GetActiveAccountService` re-projects when the projection, trusted domain or key fingerprint no longer matches the selected account, so an interrupted switch recovers instead of operating on stale state.

Switching two clicks from the vault or Quick Access selects an account, verifies the server challenge, authenticates when no local unlock is retained, and navigates to `app/passwords` or `auth/login` (`requires_unlock`). A locked selection logs out first so it cannot inherit another identity's server cookie. New accounts and logins without remember-me use a 60-second unlock; a remembered account keeps its own timeout and switching does not extend it. Lock ends the remembered unlock but keeps the encrypted key; remove drops the account and requires its private key to add it again. Listing still works offline, and a failing pending reconciliation never saves an unverified key.

**Implementation evidence:** `src/all/background_page/service/account/savedAccountsService.js`, `savedAccountRegistry.js`, `savedServerRegistry.js`, `pendingAccountSessionStorage.js`, `verifyAccountServerService.js`, `getActiveAccountService.js`, `src/all/background_page/event/savedAccountsEvents.js`. Tests: `savedAccountsService.test.js`, `savedAccountsService.round3.test.js`, `savedAccountRegistry.test.js`, `savedServerRegistry.test.js`, `savedAccountsEvents.test.js`, `savedAccountsEvents.retry.test.js`.

**Recorded validation:** the [onboarding .2 release](https://github.com/Type-Delta/passbolt_browser_extension/releases/tag/fork-v5.17.1-multi-account.2) records actual Chromium enrollment, exact account identities, remembered two-click switching, distinct secrets and real cached credential fill. [Exact source CI](https://github.com/Type-Delta/passbolt_browser_extension/actions/runs/43192421093) passed 704 suites and 5,238 tests. Actual Edge, Firefox, Safari, native toolbar interaction and a configured base-path server remain unverified.

**Last updated:** 2026-11-13

### DL002 — Foreground isolation and request fencing

Upstream has no multi-account foreground generation to fence account transitions. This fork makes the foreground explicit: `AccountContext` keeps a generation counter, drains running operations before a transition, cancels interactive requests (passphrase dialog, SSO popup, Quick Access wait), and invalidates ports from the previous generation. Workers carry the account id they were created for; port senders are checked against the selected account's canonical server (origin and path prefix) and the expected extension frame page, and ports bound to another account or another foreground are refused.

Account crossing is fenced end to end: `ApiClient` requests assert the generation and the account base URL and confirm the authenticated identity from `GET users/me` rather than from OpenPGP user ids; storage flushes are awaited so a transition cannot finish before old-account cleanup; per-account passphrase slots, SSO IndexedDB databases, session-keepalive, toolbar badge and icon work run only for the selected account; in-progress clipboard content is flushed on switch; and port payloads are no longer logged because they can contain passphrases and imported keys. The web-integration pagemod is not attached to any saved account's own base URL, so autofill and its overlay never run inside a Passbolt deployment that has a saved account.

**Implementation evidence:** `src/all/background_page/service/account/accountContext.js`, `accountApiGuard.js`, `src/all/background_page/sdk/port.js`, `src/all/background_page/sdk/port/portManager.js`, `src/all/background_page/controller/port/generatePortIdController.js`, `src/all/background_page/pagemod/pagemod.js`, `src/all/background_page/pagemod/pagemodManager.js`, `src/all/background_page/pagemod/webIntegrationPagemod.js`, `src/all/background_page/service/localStorage/localStorageService.js`, `src/all/background_page/service/toolbar/toolbarService.js`. Tests: `port.accountTransition.test.js`, `portManager.accountContext.test.js`, `appBootstrapPagemod.accountContext.test.js`, `toolbarService.accountContext.test.js`, `ssoAccountIsolation.test.js`, `accountApiGuard.test.js`.

**Recorded validation:** account-context, port, SSO and toolbar tests cover generation invalidation, cross-origin refusal, identity pinning and isolation. The .2 exact-source CI passed the complete 704-suite/5,238-test extension run, including onboarding regressions, plus three content-script DOM tests and 12 immutable-base guard tests. Actual Chromium switching, distinct secrets, fill and MFA passed on the candidate whose JavaScript bodies matched final release payloads.

**Last updated:** 2026-11-13

### DL003 — Full-tab account enrollment and the first-use prompt

Upstream offers no way to add a second account, and its toolbar opens the getting-started page when no account is configured. This fork adds `QuickAccessService.openAddAccountTab`, which authorizes the request against the originating worker and tab, suggests a server from the current URL when it is a verified Passbolt deployment, creates an inactive tab, registers a `QuickAccess` worker bound to the current account id, and navigates it to the add-account tab. Completion is transferred to that reservation; failures delete the worker and the blank tab. The toolbar now opens Quick Access whether or not an account exists.

On a top-level page that renders the Passbolt vault skeleton, with no saved account and no pending sign-in, `AccountOnboardingPagemod` verifies the page's candidate server, injects a prompt through the extension (so a page CSP cannot block its styles), and offers "Add account", which opens the same tab. The prompt re-checks the page, tab, account list and pending state before every action and disappears as soon as an account exists. `webNavigationService` recognizes the pending navigation so the tab switch is not treated as a plain navigation. Enrollment itself checks the server key, validates the private key locally, and can check a passphrase without storing anything; an account is not saved until the server confirms its identity. Explicit server selection may retain public server metadata before account enrollment completes; an MFA attempt keeps its temporary material in the existing bound session-storage flow.

**Implementation evidence:** `src/all/background_page/service/ui/quickAccess.service.js`, `src/all/background_page/pagemod/accountOnboardingPagemod.js`, `src/all/background_page/service/account/accountOnboardingService.js`, `src/all/background_page/service/crypto/validatePrivateGpgKeyService.js`, `src/all/contentScripts/js/app/AccountOnboarding.js`, `src/all/background_page/service/webNavigation/webNavigationService.js`, `src/all/background_page/service/toolbar/toolbarService.js`, `src/all/webAccessibleResources/js/themes/stylesheet.js`, `webpack.common.config.js`, `webpack/expectedBuildArtifacts.js`. Tests: `quickAccess.onboarding.test.js`, `accountOnboardingPagemod.test.js`, `accountOnboardingService.test.js`, `savedAccountsEvents.onboarding.test.js`, `test/contentScripts/AccountOnboarding.test.js`, `src/all/webAccessibleResources/js/app/QuickAccess.test.js`, `stylesheet.test.js`.

**Recorded validation:** the .2 release records real Chromium popup-click tab creation, verified server retention, key/token/unlock, an identity-mismatch error followed by a successful same-tab retry, the trusted first-use prompt with programmatic clicks refused, and the vault launcher after route navigation. Exact-source CI passed the full extension suite and three DOM tests. The shipped Firefox predicate also passed a minified named-function/polyfill probe; that was not Firefox engine execution.

**Last updated:** 2026-11-13

### DL004 — Remembered unlock slots, lock, and the TOTP handoff

Upstream keeps one passphrase and one pending-MFA notion for the single account. This fork gives every account its own unlock slot in `browser.storage.session`, its own flush alarm, and its own lock so a delayed alarm cannot destroy a refreshed session. `KeepSessionAliveService` resumes only the selected account's existing remember-until-logout choice and never extends it; `Lock` clears that account's slot and cached session/key material; locking the active account also logs out and returns its vault tabs to login. Other accounts retain their own unlock slots. A login checks whether the server already authenticates this identity (a replaced cookie is logged out and re-proven), asserts the returned user id, email and key fingerprint, and only then stores the passphrase and runs post-login work.

When the server still requires MFA, the login saves a pending account attempt (a session-storage record with an attempt id and expiry, never exposed over RPC), and the sign-in continues on the server's native TOTP verification page. While that pending attempt exists on the same backend, non-bootstrap RPCs are refused and only the MFA status, trusted-tab and post-login redirect calls are allowed; the redirect path additionally requires the Auth frame sender. Pending attempts are reconciled to a saved account only after the server confirms the identity, can be cancelled, and expire with their alarm. Enrollment supports the TOTP readiness protocol only; other MFA providers are not part of this flow.

**Implementation evidence:** `src/all/background_page/service/session_storage/passphraseStorageService.js`, `keepSessionAliveService.js`, `src/all/background_page/service/account/pendingAccountSessionStorage.js`, `savedAccountsService.js`, `accountApiGuard.js`, `src/all/background_page/controller/auth/authLoginController.js`, `isMfaRequiredController.js`, `redirectPostLoginController.js`, `src/all/background_page/controller/tab/openTrustedDomainTabController.js`, `src/all/background_page/service/sso/popupHandlerService.js`, `src/all/background_page/service/passphrase/getPassphraseService.js`, `src/all/background_page/sdk/port.js`. Tests: `authLoginController.mfa.test.js`, `redirectPostLoginController.pending.test.js`, `accountMfaReadiness.test.js`, `passphraseStorageService.test.js`, `getPassphraseService.accountContext.test.js`, `savedAccountsEvents.onboarding.test.js`.

**Recorded validation:** unit tests cover slot isolation, expiry, pending gating and the MFA redirect. The .2 Chromium acceptance established remembered slots using ordinary login controls, switched A to B to A without a passphrase prompt, and completed both new-enrollment and saved-web TOTP sign-ins with exact identities. It did not certify every timeout duration through a long-running browser session.

**Last updated:** 2026-11-13

### DL005 — Pinned UI input, release build, and packaging

Upstream installs `passbolt-styleguide` from the npm registry. This fork consumes a tarball built from a pinned commit: `ui-pin.json` records the source repository, full commit, package version, tarball SHA-256 and npm integrity, and `package.json`/`package-lock.json` consume `file:vendor/passbolt-styleguide.tgz` with the same integrity. `npm run ui:pin` builds the clean styleguide, rebuilds it from a fresh detached worktree, and writes the pin only when both tarballs are byte-identical; `npm run ui:bootstrap` regenerates the ignored vendor tarball from the committed pin. Every build has a `prebuild` hook that runs `ui:verify`, so a missing, replaced or stale tarball fails before webpack runs, and local acceptance artifacts (`localOnly`) can never satisfy release verification.

`npm run release:build` rebuilds the browser bundles, server assets and release bundle; `npm run release:package` writes `BUILD-MANIFEST.json`, checksums and the downloadable bundle. The release workflow runs lint, the unit suite, the content-script DOM tests, the frontend overlay guard, a pinned-UI rebuild and the Docker image verification, and publishes on `fork-v*` tags or an explicit publication dispatch. The inherited empty release workflow is removed, and the inherited CodeQL workflow is updated for current GitHub runners. `lockfile-lint` now accepts the `file:` scheme for the vendored tarball.

**Implementation evidence:** `ui-pin.json`, `package.json`, `package-lock.json`, `.nvmrc`, `scripts/with-release-toolchain.sh`, `scripts/sync-ui.mjs`, `scripts/verify-ui.mjs`, `scripts/local-ui-test.mjs`, `scripts/build-release.mjs`, `scripts/package-release.mjs`, `scripts/lib/artifacts.mjs`, `.github/workflows/fork-build-release.yml`, `.github/workflows/codeql-analysis.yml`, `docs/fork-build-release.md`, `README.md`.

**Recorded validation:** the .2 pin was reproduced from two clean checkout paths and then independently rebuilt by [successful publication run 43195456025](https://github.com/Type-Delta/passbolt_browser_extension/actions/runs/43195456025). Published asset digests, checksum entries and manifest entries passed; browser file bodies matched green CI exactly, and the web archive, UI tarball and server manifest were byte-identical. Both source dirty flags and local-only flags were false. Dirty-source rejection controls were also recorded. For the 2026-11-13 UI polish and fork-record initialization, two clean builds of `fb1cfcbd051cdcbd1e0a32a1ec0dfc425898030d` reproduced SHA-256 `fbc8604d6f10e4c0faefd09471aea313347886cd4e307b8eae5253519e13f81b`; `ui:verify` passed before this pin was committed. Later UI changes require a new clean pin and the same checks.

**Last updated:** 2026-11-13

### DL006 — Matched server frontend overlay on an immutable base

The stock browser extension cannot render the fork's account UI on a server page, and Passbolt's server serves its own frontend assets. This fork ships a matched frontend image that overlays only UI assets and six reviewed templates on the immutable base recorded in `deploy/passbolt-frontend/base-image.json` (repository digest, canonical image id, platform, ordered rootfs layers, template hashes). The backend API, schema, PHP runtime, entrypoint and inherited runtime configuration stay stock; a different base or platform requires a newly reviewed pin.

The builder verifies the UI tarball hash and integrity, checks the reviewed template copies and the base image's templates against the pinned hashes, and rewrites only asset query values and `cache-version` attributes to `ui-<tarball sha256>` in `Auth/triage.php`, `Home/api_app.php`, `Home/api_ext_app.php`, `Setup/SetupStart/start.php`, `Setup/RecoverStart/start.php` and the native CE TOTP layout. The manifest (schema 2) allows only APP-root-relative `webroot/**` paths excluding six inherited PNG icons plus the six template paths, rejects absolute paths, traversal, duplicates, symlinks and special files, normalizes modes, and embeds the whole manifest at `webroot/.passbolt-fork-frontend.json`. The image verifier checks every staged hash and size, the embedded manifest, base layers and inherited runtime, verifies PHP syntax for the six templates as the service user, and handles both classic and containerd image stores. The fork's stylesheet consumer and shared translation helper use the same revision so CSS and locale requests are cache-busted on newly served pages; error, health and report pages outside the allowlist keep the stock cache keys.

**Implementation evidence:** `deploy/passbolt-frontend/Dockerfile`, `base-image.json`, `build-image.sh`, `README.md`, `templates/**`, `plugins/PassboltCe/MultiFactorAuthentication/templates/layout/mfa_verify.php`, `scripts/build-server-assets.mjs`, `scripts/lib/frontend-overlay.mjs`, `scripts/validate-frontend-context.mjs`, `scripts/verify-image.mjs`, `scripts/package-release.mjs`.

**Recorded validation:** both image-store formats were exercised with repository-digest/platform/layer checks and rejection controls. The .2 image passed committed and independent verification of 105 frontend hashes/sizes, public modes, six PHP syntax checks, the embedded manifest, inherited runtime and twelve base layers plus one overlay. Disposable Chromium happy paths and anonymous deployed origin/public revisioned assets and GPG health passed. This does not prove every stock 5.16 deployment shape, owner authentication, arbitrary CDN persistence or actual production rollback.

**Last updated:** 2026-11-13

### DL007 — Separate extension identity in every manifest

Upstream's manifests are branded "Passbolt", use the official Firefox add-on id and leave the Chromium key unspecified, so a fork build would be indistinguishable from the official product and could not be installed side by side. Every manifest in this fork sets its own name, short name, description, action title, homepage URL and `version_name` suffix; the Chromium manifests carry the fork's own public key so the unpacked build keeps one stable extension id, and the Firefox manifest uses the fork's own add-on id. No manifest contains an upstream update URL, so the fork never auto-updates from the official release channel.

**Implementation evidence:** `src/chrome-mv3/manifest.json`, `src/chrome/manifest.json`, `src/firefox/manifest.json`, `src/safari/manifest.json`, `docs/fork-build-release.md`.

**Recorded validation:** the downloaded .2 packages were inspected: Chromium public-key identity `ibkcmmjpbjkangebjmfominbhihgnmld`, Firefox id `passbolt-multi-account@type-delta.github.io`, no upstream update URL, and unsigned Firefox provenance. There is no dedicated unit assertion for all identity values; release inspection remains required.

**Last updated:** 2026-11-13

## Sync Checklist

Project-specific checks every upstream sync runs, in addition to the full test suite, lint, typecheck, builds, and a smoke test of upstream and fork features.

- Reconstruct the pinned toolchain (Node 22.14.0, npm 10.9.2), run `npm run ui:bootstrap` (or `npm run ui:pin` when re-pinning) against a clean adjacent styleguide checkout, then `npm run ui:verify`, `npm ci`, `npm run lint`, `npm run test:unit`, `node node_modules/jest/bin/jest.js --config test/jest.dom.config.cjs --runInBand --no-cache`, and `node --test scripts/lib/frontend-overlay.test.mjs`.
- Rebuild the styleguide tarball from the `ui-pin.json` commit twice from different checkout paths and confirm it still matches the recorded SHA-256, integrity and lockfile; then run `npm run release:build` and inspect `BUILD-MANIFEST.json`, both browser ZIPs, the matched UI archive and `SHA256SUMS`.
- Inspect packaging identities: every manifest carries the fork name and ids, `version_name`, the stable Chromium key, the fork Firefox add-on id, and no upstream update URL; `passbolt-styleguide` resolves to the vendored tarball.
- Pull the exact base digest from `deploy/passbolt-frontend/base-image.json`, build the frontend image, and run the verifier: unchanged base layers, exactly one new layer, template hashes, PHP syntax as the service user, inherited runtime configuration, `ui-<sha256>` revision, and rejection of `localOnly` provenance for a release.
- With two disposable HTTPS Passbolt backends and the built extension, run the real multi-account happy path: first-use prompt opens enrollment, add an account in the full tab, switch without re-importing, keep a remembered unlock across switches, lock and re-unlock, complete a TOTP-only MFA handoff, then cached-fill a login on a non-Passbolt site.
- Smoke the isolation boundaries: while a pending TOTP sign-in exists, other account requests are refused; switching closes the previous account's ports; no passphrase or private key appears in logs; the web-integration pagemod stays off a saved account's own deployment.
- Publishing and deployment are separate release tasks, performed when explicitly requested. Sync verification uses disposable accounts and does not require owner credentials.

## Merge History

This is an append-only decision record, newest first, with one entry per upstream sync. It explains past integrations but does not by itself establish a current divergence; use the Divergence Log for that. Sync with upstream only when the user explicitly asks. Do not edit past entries.

Initialized with `syncfork init` on 2026-11-13 at upstream `master` commit `9db5c2856c23a97819f1d7875afba7fc35b75a0b`, the confirmed `base` tag target. No fork-specific upstream sync had occurred. Initialization and merging the fork's own feature PR are not upstream syncs.
