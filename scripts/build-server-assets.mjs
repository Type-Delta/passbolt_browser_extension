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
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ROOT,
  assertFile,
  listFiles,
  parseOptions,
  readJson,
  relativeFileManifest,
  sha256,
  sha512Integrity,
} from "./lib/artifacts.mjs";

import {
  APP_ROOT,
  INHERITED_ICON_PATHS,
  base,
  frontendRevision,
  stageTemplates,
  validateContext,
} from "./lib/frontend-overlay.mjs";

const options = parseOptions(process.argv.slice(2), {
  "--tarball": {key: "tarball"},
  "--out": {key: "out"},
  "--ui-artifact": {key: "uiArtifact"},
});

if (options.help) {
  console.log("Usage: node scripts/build-server-assets.mjs [--tarball FILE] [--out DIR] [--ui-artifact MANIFEST]");
  process.exit(0);
}

const run = (command, args, cwd = ROOT) => {
  const result = spawnSync(command, args, {cwd, stdio: "inherit"});
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
};

const resolveUi = () => {
  const localArtifact = process.env.PASSBOLT_UI_LOCAL_ARTIFACT;
  const localAcceptance = process.env.PASSBOLT_UI_LOCAL_ACCEPTANCE === "1";
  if (localAcceptance && localArtifact) {
    const artifactPath = path.resolve(ROOT, localArtifact);
    assertFile(artifactPath, "local UI artifact manifest");
    const artifact = readJson(artifactPath);
    if (!artifact.localOnly) {
      throw new Error("Local UI acceptance was requested but the artifact is not marked localOnly");
    }
    return {
      ...artifact.source,
      version: artifact.version,
      tarballSha256: artifact.tarball.sha256,
      tarballIntegrity: artifact.tarball.integrity,
      localOnly: true,
    };
  }

  const pinPath = path.join(ROOT, "ui-pin.json");
  assertFile(pinPath, "ui-pin.json");
  const pin = readJson(pinPath);
  if (pin.sourceDirty) {
    throw new Error("ui-pin.json is marked dirty; release server assets require a clean committed UI pin");
  }
  return {...pin, localOnly: false};
};

const ui = resolveUi();
const tarballPath = path.resolve(ROOT, options.tarball || "vendor/passbolt-styleguide.tgz");
const outputDirectory = path.resolve(ROOT, options.out || "dist/server-frontend");
assertFile(tarballPath, "styleguide tarball");
if (sha256(tarballPath) !== ui.tarballSha256) {
  throw new Error("Styleguide tarball SHA-256 does not match ui-pin.json/local artifact");
}
if (sha512Integrity(tarballPath) !== ui.tarballIntegrity) {
  throw new Error("Styleguide tarball integrity does not match ui-pin.json/local artifact");
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "passbolt-server-assets-"));
try {
  const extractedPackage = path.join(temporaryDirectory, "package");
  run("tar", ["-xzf", tarballPath, "-C", temporaryDirectory]);
  assertFile(path.join(extractedPackage, "package.json"), "styleguide package.json");

  if (fs.existsSync(outputDirectory)) {
    fs.rmSync(outputDirectory, {recursive: true, force: true});
  }
  const rootfs = path.join(outputDirectory, "rootfs");
  const webroot = path.join(rootfs, "webroot");

  const mapping = [];
  const copy = (sourceRelative, destinationRelative, required = true, filter) => {
    const source = path.join(extractedPackage, sourceRelative);
    if (!fs.existsSync(source)) {
      if (required) {
        throw new Error(`Required styleguide asset is missing: ${sourceRelative}`);
      }
      return;
    }
    const destination = path.join(webroot, destinationRelative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.cpSync(source, destination, {recursive: true, filter});
    mapping.push({from: sourceRelative, to: destinationRelative});
  };

  copy("src/fonts", "fonts");
  copy(
    "src/img/webroot",
    ".",
    true,
    (source) =>
      !INHERITED_ICON_PATHS.includes(
        `webroot/${path.relative(path.join(extractedPackage, "src/img/webroot"), source).split(path.sep).join("/")}`,
      ),
  );
  copy("src/locales", "locales");
  copy("src/img/avatar", "img/avatar");
  copy("src/img/themes", "img/themes", true, (source) => fs.statSync(source).isDirectory() || source.endsWith(".png"));

  const imageFiles = [
    "logo/logo.png",
    "logo/logo.svg",
    "logo/logo_white.svg",
    "controls/check_black.svg",
    "controls/check_tick.svg",
    "controls/chevron-down_black.svg",
    "controls/chevron-down_blue.svg",
    "controls/dot_white.svg",
    "controls/dot_red.svg",
    "controls/dot_black.svg",
    "controls/infinite-bar.gif",
    "controls/loading_light.svg",
    "controls/loading_dark.svg",
    "controls/overlay-opacity-50.png",
    "controls/success.svg",
    "controls/fail.svg",
    "controls/warning.svg",
    "controls/attention.svg",
    "third_party/FirefoxAMO_black.svg",
    "third_party/FirefoxAMO_white.svg",
    "third_party/ChromeWebStore_black.svg",
    "third_party/ChromeWebStore_white.svg",
    "third_party/appstore.svg",
    "third_party/edge-addon-black.svg",
    "third_party/edge-addon-white.svg",
    "third_party/firefox.svg",
    "third_party/chrome.svg",
    "third_party/edge.svg",
    "third_party/brave.svg",
    "third_party/vivaldi.svg",
    "third_party/safari.svg",
    "third_party/aws-ses.svg",
    "third_party/elastic-email.svg",
    "third_party/gmail.svg",
    "third_party/mailgun.svg",
    "third_party/mailjet.svg",
    "third_party/mandrill.svg",
    "third_party/sendgrid.svg",
    "third_party/sendinblue.svg",
    "third_party/zoho.svg",
    "third_party/outlook.svg",
    "third_party/office365.svg",
    "illustrations/email.png",
    "diagrams/totp.svg",
    "third_party/duo.svg",
    "third_party/google-authenticator.svg",
    "third_party/yubikey.svg",
  ];
  for (const imageFile of imageFiles) {
    // Match the stock server build helper: several historical image paths are
    // no longer present in newer styleguide packages and remain unchanged in
    // the base image.
    copy(`src/img/${imageFile}`, `img/${imageFile}`, false);
  }

  const builtJs = path.join(extractedPackage, "build/js/dist");
  if (!fs.existsSync(builtJs) || !fs.statSync(builtJs).isDirectory()) {
    throw new Error(`StyleGuide JavaScript build directory is missing: ${builtJs}`);
  }
  const jsFiles = fs
    .readdirSync(builtJs)
    .filter((name) => /^api-.*\.js$/.test(name))
    .sort();
  if (!jsFiles.includes("api-app.js") || !jsFiles.includes("api-vendors.js")) {
    throw new Error("Styleguide build is missing api-app.js or api-vendors.js");
  }
  for (const jsFile of jsFiles) {
    copy(`build/js/dist/${jsFile}`, `js/app/${jsFile}`);
  }

  const themes = ["default", "midgar", "solarized_light", "solarized_dark"];
  const cssFiles = [
    "api_main.min.css",
    "api_authentication.min.css",
    "api_reports.min.css",
    "api_webinstaller.min.css",
    "api_cloud.min.css",
    "ext_authentication.min.css",
  ];
  for (const theme of themes) {
    for (const cssFile of cssFiles) {
      copy(`build/css/themes/${theme}/${cssFile}`, `css/themes/${theme}/${cssFile}`, false);
    }
  }

  const revision = frontendRevision(ui.tarballSha256);
  stageTemplates(rootfs, revision);
  const stagedFiles = listFiles(rootfs);
  const manifest = {
    schemaVersion: 2,
    ui: {
      repository: ui.repository,
      commit: ui.commit,
      version: ui.version,
      dirty: ui.localOnly ? Boolean(ui.dirty ?? ui.sourceDirty ?? true) : false,
      localOnly: ui.localOnly,
      tarballSha256: ui.tarballSha256,
      tarballIntegrity: ui.tarballIntegrity,
    },
    server: {
      baseImage: base.reference,
      baseImageId: base.imageId,
      appRoot: APP_ROOT,
      frontendRevision: revision,
      baseTemplateSha256: base.templateSha256,
      webroot: `/usr/share/php/passbolt/webroot`,
      mapping,
    },
    files: relativeFileManifest(rootfs, stagedFiles),
  };

  const manifestPath = path.join(outputDirectory, "MANIFEST.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const imageManifestPath = path.join(webroot, ".passbolt-fork-frontend.json");
  fs.writeFileSync(imageManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(
    path.join(ROOT, "deploy/passbolt-frontend/Dockerfile"),
    path.join(outputDirectory, "Dockerfile"),
  );

  // Only the generated public overlay is normalized, never sources or runtime data.
  const normalizePublicModes = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink in public overlay: ${current}`);
    }
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o755);
      for (const name of fs.readdirSync(current)) {
        normalizePublicModes(path.join(current, name));
      }
    } else if (stat.isFile()) {
      fs.chmodSync(current, 0o644);
    } else {
      throw new Error(`Non-file public overlay entry: ${current}`);
    }
  };
  normalizePublicModes(rootfs);
  validateContext(outputDirectory);

  const shortCommit = ui.commit.slice(0, 12);
  const archiveName = `passbolt-web-ui-assets-${ui.version}-${shortCommit}${ui.localOnly ? "-local" : ""}.tar.gz`;
  const archivePath = path.join(outputDirectory, archiveName);
  const tarPath = path.join(temporaryDirectory, "server-frontend.tar");
  run("tar", [
    "--sort=name",
    "--format=gnu",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mtime=@0",
    "-cf",
    tarPath,
    "-C",
    outputDirectory,
    "Dockerfile",
    "MANIFEST.json",
    "rootfs",
  ]);
  execFileSync("gzip", ["-n", tarPath], {stdio: "inherit"});
  fs.copyFileSync(`${tarPath}.gz`, archivePath);
  fs.rmSync(`${tarPath}.gz`);

  const checksums = [
    `${sha256(archivePath)}  ${path.basename(archivePath)}`,
    `${sha256(manifestPath)}  MANIFEST.json`,
    `${sha256(path.join(outputDirectory, "Dockerfile"))}  Dockerfile`,
  ].join("\n");
  fs.writeFileSync(path.join(outputDirectory, "SHA256SUMS"), `${checksums}\n`);

  console.log(`[server-assets] Staged ${stagedFiles.length} frontend files`);
  console.log(`[server-assets] Wrote ${archivePath}`);
  console.log(`[server-assets] Wrote ${manifestPath}`);
  console.log(`[server-assets] localOnly=${ui.localOnly}`);
} finally {
  fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}
