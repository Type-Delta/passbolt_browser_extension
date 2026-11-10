# Matched Passbolt frontend image

This image overlays matched UI assets and six view templates on the immutable stock base recorded in `base-image.json`. It preserves the backend API, database schema, PHP runtime, entrypoint and inherited runtime configuration. The Dockerfile's default must match that JSON reference. There is no tag or version fallback.

`build-server-assets.mjs` verifies the UI tarball SHA-256 and SHA-512 integrity using the existing release-pin or explicit local-acceptance flow. It reads reviewed stock template copies from this directory. Both those copies and the exact base image's templates must match the pinned SHA-256 values before staging. Docker must have the public base available locally with the pinned repository digest, platform and ordered root filesystem layer digests. These checks work with both classic and containerd image stores, whose reported image IDs differ. The pin's `imageId` records the canonical configuration digest for provenance. A different platform/base requires a separately reviewed pin and template hashes.

The revision is `ui-<full verified UI tarball SHA-256>`. It replaces only asset query values and `cache-version` attributes in `Auth/triage.php`, `Home/api_app.php`, `Home/api_ext_app.php`, `Setup/SetupStart/start.php`, `Setup/RecoverStart/start.php`, and the native CE MFA layout `plugins/PassboltCe/MultiFactorAuthentication/templates/layout/mfa_verify.php`. The backend `passbolt.version` is unchanged. Stock `stylesheet.js` consumes that attribute for CSS theme URLs and stays inherited.

The tarball mapping remains:

| Source | APP-root-relative destination |
| --- | --- |
| `build/js/dist/api-*.js` | `webroot/js/app/` |
| `build/css/themes/<theme>/*.min.css` | `webroot/css/themes/<theme>/` |
| `src/locales/`, `src/fonts/`, `src/img/webroot/` | `webroot/locales/`, `webroot/fonts/`, `webroot/`, except six inherited PNG icons |
| Selected avatar, theme and image files | `webroot/img/` |
| Six reviewed stock templates, cache values revised | Exact paths under `templates/` and the native CE MFA plugin |

The builder excludes exactly six legacy PNG paths from `src/img/webroot`: `favicon.png`, `apple-touch-icon.png`, `apple-touch-icon-precomposed.png`, and the 57x57, 72x72 and 114x114 precomposed apple-touch icons. Their stock bytes stay inherited from the exact base. The path validator also rejects these six overlay destinations, including in stale contexts. Other assets retain the existing mapping.

Manifest schema 2 lists APP-root-relative paths beneath `/usr/share/php/passbolt`. Only `webroot/**`, excluding those six icons, and the exact six template paths are accepted. Absolute paths, traversal, duplicate paths and symlinks fail. `webroot/.passbolt-fork-frontend.json` embeds the entire manifest and is checked separately to avoid a self-hash. File counts come from the staged inventory. The generated public rootfs is normalized to 0755 directories and 0644 files, including its root and embedded manifest, before archiving or Docker COPY. Symlinks and special files are rejected without following them; no source or runtime paths are chmodded. Context validation rejects different modes. One rootfs COPY adds one layer.

## Build and verification

Before the repository's release build, fetch the exact public base for template verification. CI does this before generating release assets.

```sh
docker pull "$(node -p 'require("./deploy/passbolt-frontend/base-image.json").reference')"
```

After staging a verified UI tarball and completing the repository's release build:

```sh
./deploy/passbolt-frontend/build-image.sh --tag passbolt-frontend:reviewed-release
```

`--skip-build --context <context>` validates the context's pin, schema, revision, every file hash/size, path allowlist, embedded manifest and Dockerfile before Docker runs. Old manifests must be regenerated. Release packaging uses the same validation and records the exact base ID and revision.

The image verifier checks every listed file hash/size and symlink-free destination, the complete embedded manifest, syntax of all six PHP templates in the exact image, unchanged base layers, exactly one new layer and inherited runtime configuration. File hashes, the embedded manifest and PHP syntax are checked as `www-data`, proving service-user readability. All inspection containers use `--network none` and explicit entrypoints. They start no application services.

Local acceptance remains explicitly `localOnly=true`; it cannot establish release provenance. Clean UI pinning, matched extension rebuilding and CI publication remain separate prerequisites.

## Cache validation and rollout

Fresh HTML from the six allowlisted templates uses the content revision for its asset query values and stylesheet/theme CSS requests. The native MFA page is server-rendered; only its stylesheet URL and CSS cache-version attribute change. Its forms and provider behavior remain stock. Existing tabs need fresh HTML. This does not claim to refresh already-running pages or prove a CDN includes queries in its cache key.

The matched UI tarball supplies changed locale JSON and a shared translation-path helper. On HTTP(S) pages with a valid frontend revision in `#stylesheet-manager`, the helper stamps same-origin locale URLs; extension-local URLs and other origins remain unchanged. CSS image/font URLs stay stable, so compare their final bytes with the base. The six excluded favicon/apple-touch PNG files retain their stock base bytes.

Stock error, health and report pages outside this exact six-template allowlist can retain backend-version CSS cache keys. This is a remaining cosmetic cache limitation for staging and rollback checks; this overlay does not revise those pages. Before release, inventory the final tarball and test auth, vault, native TOTP, setup/recovery, themes and served locales with cold and old populated caches. Confirm requested URL revisions and response hashes, public query-cache behavior and rollback. Do not modify backend version, app configuration or CDN behavior to bypass these checks.

Deploy only after exact-base staging and release acceptance. Preserve database, GPG, JWT and other persistent storage and runtime settings. Record the prior immutable image ID for rollback and follow the deployment's tested backup procedure. Restore the exact previous image for frontend rollback. Cache tests also apply in reverse.
