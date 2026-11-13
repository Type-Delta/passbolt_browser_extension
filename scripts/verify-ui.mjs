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
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {ROOT, assertFile, readJson, sha256, sha512Integrity} from "./lib/artifacts.mjs";

const LOCAL_ARTIFACT_ENV = "PASSBOLT_UI_LOCAL_ARTIFACT";
const LOCAL_ACCEPTANCE_ENV = "PASSBOLT_UI_LOCAL_ACCEPTANCE";
const packageJson = readJson(path.join(ROOT, "package.json"));
const lockfile = readJson(path.join(ROOT, "package-lock.json"));
const dependencySpec = packageJson.dependencies["passbolt-styleguide"];
const lockPackage = lockfile.packages?.["node_modules/passbolt-styleguide"];
const rootDependency = lockfile.packages?.[""]?.dependencies?.["passbolt-styleguide"];

const verifyLockfile = (tarballSpec, integrity) => {
  if (dependencySpec !== tarballSpec || rootDependency !== tarballSpec || lockPackage?.resolved !== tarballSpec) {
    throw new Error(`package.json/package-lock.json must consume ${tarballSpec}`);
  }
  if (lockPackage?.integrity !== integrity) {
    throw new Error("package-lock.json integrity does not match the selected styleguide tarball");
  }
};

const verifyArtifact = (artifactPath, expectedTarball, strictPin) => {
  assertFile(artifactPath, "styleguide artifact manifest");
  const artifact = readJson(artifactPath);
  if (artifact.localOnly && strictPin) {
    throw new Error("A developer-only local UI artifact cannot satisfy release pin verification");
  }
  if (artifact.name !== "passbolt-styleguide") {
    throw new Error(`Unexpected styleguide package name: ${artifact.name}`);
  }
  assertFile(expectedTarball, "vendored styleguide tarball");
  if (sha256(expectedTarball) !== artifact.tarball.sha256) {
    throw new Error("Vendored styleguide tarball SHA-256 does not match its artifact manifest");
  }
  if (sha512Integrity(expectedTarball) !== artifact.tarball.integrity) {
    throw new Error("Vendored styleguide tarball integrity does not match its artifact manifest");
  }
  verifyLockfile(`file:${path.relative(ROOT, expectedTarball)}`, artifact.tarball.integrity);
  return artifact;
};

const localMode = process.env[LOCAL_ACCEPTANCE_ENV] === "1" && Boolean(process.env[LOCAL_ARTIFACT_ENV]);
if (localMode) {
  console.warn("[verify-ui] DEVELOPER-ONLY local UI artifact accepted. This mode is never enabled by CI.");
  const artifactPath = path.resolve(ROOT, process.env[LOCAL_ARTIFACT_ENV]);
  const artifact = verifyArtifact(
    artifactPath,
    path.join(ROOT, "vendor/passbolt-styleguide.tgz"),
    false,
  );
  console.warn(`[verify-ui] local styleguide ${artifact.version} ${artifact.source.commit} dirty=${artifact.source.dirty}`);
  process.exit(0);
}

assertFile(path.join(ROOT, "ui-pin.json"), "ui-pin.json");
const pin = readJson(path.join(ROOT, "ui-pin.json"));
if (pin.sourceDirty) {
  throw new Error("ui-pin.json is marked dirty; release builds require a clean committed styleguide pin");
}
if (!/^[0-9a-f]{40}$/.test(pin.commit || "")) {
  throw new Error("ui-pin.json must contain a full 40-character styleguide commit SHA");
}

const tarballPath = path.join(ROOT, pin.tarball);
assertFile(tarballPath, "vendored styleguide tarball");
if (sha256(tarballPath) !== pin.tarballSha256) {
  throw new Error("Vendored styleguide tarball SHA-256 does not match ui-pin.json");
}
if (sha512Integrity(tarballPath) !== pin.tarballIntegrity) {
  throw new Error("Vendored styleguide tarball integrity does not match ui-pin.json");
}
verifyLockfile(`file:${pin.tarball}`, pin.tarballIntegrity);
console.log(`[verify-ui] Verified clean styleguide ${pin.version} from ${pin.commit}`);
