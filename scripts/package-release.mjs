#!/usr/bin/env node
/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 */
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ROOT,
  assertFile,
  gitValue,
  parseOptions,
  readJson,
  sha256,
  writeJson,
} from "./lib/artifacts.mjs";

import {validateContext} from "./lib/frontend-overlay.mjs";

const options = parseOptions(process.argv.slice(2), {
  "--out": {key: "out"},
  "--refresh": {key: "refresh", type: "boolean"},
});
if (options.help) {
  console.log("Usage: node scripts/package-release.mjs [--out DIR] [--refresh]");
  process.exit(0);
}

const outputDirectory = path.resolve(ROOT, options.out || "dist/release");
const packageJson = readJson(path.join(ROOT, "package.json"));
const chromiumManifest = readJson(path.join(ROOT, "src/chrome-mv3/manifest.json"));
const firefoxManifest = readJson(path.join(ROOT, "src/firefox/manifest.json"));
const serverManifestPath = path.join(ROOT, "dist/server-frontend/MANIFEST.json");
assertFile(serverManifestPath, "server frontend manifest");
const serverManifest = validateContext(path.dirname(serverManifestPath));
const ui = serverManifest.ui;
const extensionCommit = gitValue(ROOT, "rev-parse", "HEAD");
const extensionRef = gitValue(ROOT, "rev-parse", "--abbrev-ref", "HEAD");
const extensionDirty = gitValue(ROOT, "status", "--porcelain").length > 0;
if (extensionDirty && !ui.localOnly) {
  throw new Error("Release packaging requires a clean extension source tree");
}
const shortExtensionCommit = extensionCommit.slice(0, 12);
const shortUiCommit = ui.commit.slice(0, 12);

if (!options.refresh && fs.existsSync(outputDirectory)) {
  fs.rmSync(outputDirectory, {recursive: true, force: true});
}
fs.mkdirSync(outputDirectory, {recursive: true});

const findSingle = (directory, predicate, label) => {
  if (!fs.existsSync(directory)) {
    throw new Error(`Missing ${label} directory: ${directory}`);
  }
  const matches = fs
    .readdirSync(directory)
    .filter(predicate)
    .sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}`);
  }
  return path.join(directory, matches[0]);
};

const chromiumZip = findSingle(
  path.join(ROOT, "dist/chromium-mv3"),
  (name) => name.endsWith(".zip"),
  "Chromium MV3 ZIP",
);
const firefoxZip = findSingle(
  path.join(ROOT, "dist/firefox"),
  (name) => name.endsWith(".zip"),
  "Firefox ZIP",
);
const webAssetsArchive = findSingle(
  path.join(ROOT, "dist/server-frontend"),
  (name) => name.startsWith("passbolt-web-ui-assets-") && name.endsWith(".tar.gz"),
  "web UI asset archive",
);
const uiTarball = path.join(ROOT, "vendor/passbolt-styleguide.tgz");
assertFile(uiTarball, "vendored styleguide tarball");

const chromiumName = `passbolt-multi-account-${packageJson.version}-chromium-mv3-${shortExtensionCommit}.zip`;
const firefoxName = `passbolt-multi-account-${packageJson.version}-firefox-unsigned-${shortExtensionCommit}.zip`;
const uiTarballName = `passbolt-styleguide-${ui.version}-fork.tgz`;
fs.copyFileSync(chromiumZip, path.join(outputDirectory, chromiumName));
fs.copyFileSync(firefoxZip, path.join(outputDirectory, firefoxName));
fs.copyFileSync(webAssetsArchive, path.join(outputDirectory, path.basename(webAssetsArchive)));
fs.copyFileSync(uiTarball, path.join(outputDirectory, uiTarballName));
fs.copyFileSync(serverManifestPath, path.join(outputDirectory, "passbolt-server-frontend-manifest.json"));
fs.copyFileSync(
  path.join(ROOT, "deploy/passbolt-frontend/Dockerfile"),
  path.join(outputDirectory, "Dockerfile.passbolt-frontend"),
);

const existingSignature = fs
  .readdirSync(outputDirectory)
  .find((name) => name.endsWith(".xpi"));
const signedFirefox = Boolean(existingSignature);

const extensionId = (() => {
  const key = chromiumManifest.key;
  if (!key) {
    throw new Error("Chromium manifest must contain a stable public key");
  }
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return Array.from(digest)
    .map((byte) => "abcdefghijklmnop"[byte >> 4] + "abcdefghijklmnop"[byte & 15])
    .join("");
})();

const artifactNames = fs
  .readdirSync(outputDirectory)
  .filter((name) => !["BUILD-MANIFEST.json", "RELEASE_NOTES.md", "SHA256SUMS"].includes(name))
  .sort();
const artifacts = artifactNames.map((name) => {
  const filePath = path.join(outputDirectory, name);
  return {name, sha256: sha256(filePath), bytes: fs.statSync(filePath).size};
});

const buildManifest = {
  schemaVersion: 1,
  localOnly: Boolean(ui.localOnly),
  extension: {
    name: packageJson.name,
    version: packageJson.version,
    manifestVersion: chromiumManifest.version,
    repository: gitValue(ROOT, "remote", "get-url", "origin"),
    commit: extensionCommit,
    ref: extensionRef,
    dirty: extensionDirty,
    identities: {
      chromiumExtensionId: extensionId,
      firefoxAddonId: firefoxManifest.browser_specific_settings.gecko.id,
    },
  },
  ui: {
    repository: ui.repository,
    version: ui.version,
    commit: ui.commit,
    localOnly: Boolean(ui.localOnly),
    tarballSha256: ui.tarballSha256,
    tarballIntegrity: ui.tarballIntegrity,
  },
  server: {
    baseImage: serverManifest.server.baseImage,
    baseImageId: serverManifest.server.baseImageId,
    appRoot: serverManifest.server.appRoot,
    frontendRevision: serverManifest.server.frontendRevision,
    webroot: serverManifest.server.webroot,
    frontendFileCount: serverManifest.files.length,
  },
  firefoxSigned: signedFirefox,
  artifacts,
};
writeJson(path.join(outputDirectory, "BUILD-MANIFEST.json"), buildManifest);

const installNotes = ui.localOnly
  ? "> **DEVELOPER-ONLY LOCAL BUILD.** This artifact was built from a mutable UI working tree and is not accepted by release verification."
  : "> Release artifacts are pinned to the UI commit and tarball hashes in `BUILD-MANIFEST.json`.";
const signedNote = signedFirefox
  ? "A Mozilla-signed Firefox XPI is included."
  : "No Mozilla-signed Firefox XPI is included. The Firefox ZIP is an unsigned temporary-load developer artifact.";
const releaseNotes = `# Passbolt Multi-Account Fork ${packageJson.version}

${installNotes}

- Extension source: \`${extensionCommit}\`${extensionDirty ? " (dirty working tree)" : ""}
- UI source: \`${ui.commit}\` (${ui.version})
- Stock server base: \`${serverManifest.server.baseImage}\`
- Chromium extension ID: \`${extensionId}\`
- Firefox add-on ID: \`${firefoxManifest.browser_specific_settings.gecko.id}\`

## Artifacts

${artifacts.map((artifact) => `- \`${artifact.name}\``).join("\n")}

## Installation

### Chromium developer build

Extract \`${chromiumName}\`, open \`chrome://extensions\`, enable Developer mode, choose **Load unpacked**, and select the extracted directory. This developer ZIP has the stable fork extension ID shown above.

### Firefox developer build

${signedNote}

The unsigned ZIP is only for temporary development loading through \`about:debugging#/runtime/this-firefox\` → **Load Temporary Add-on**. It is not a normal persistent Firefox installation and disappears when Firefox restarts.

${signedFirefox ? "The signed XPI can be installed through Firefox's normal add-on installation flow for unlisted extensions." : ""}

No upstream update URL is included. Updates come only from this fork's published releases or a Mozilla-signed unlisted build.

## Matched web UI

\`${path.basename(webAssetsArchive)}\` contains the generated Passbolt webroot and cache-revised view-template overlay, \`MANIFEST.json\`, and the Dockerfile. The same UI tarball is the source of both the extension UI bundle and the server assets.

Verify all files with \`sha256sum -c SHA256SUMS\`.
`;
fs.writeFileSync(path.join(outputDirectory, "RELEASE_NOTES.md"), releaseNotes);

const checksummedFiles = fs
  .readdirSync(outputDirectory)
  .filter((name) => name !== "SHA256SUMS")
  .sort();
fs.writeFileSync(
  path.join(outputDirectory, "SHA256SUMS"),
  `${checksummedFiles.map((name) => `${sha256(path.join(outputDirectory, name))}  ${name}`).join("\n")}\n`,
);

console.log(`[release] Wrote ${outputDirectory}`);
console.log(`[release] chromium=${chromiumName}`);
console.log(`[release] firefox=${firefoxName} signed=${signedFirefox}`);
console.log(`[release] localOnly=${ui.localOnly}`);
