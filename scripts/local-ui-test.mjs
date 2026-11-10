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
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ROOT,
  assertFile,
  parseOptions,
  readJson,
  sha256,
  sha512Integrity,
  updateStyleguideLockfile,
} from "./lib/artifacts.mjs";

const DEFAULT_SOURCE = path.resolve(ROOT, "../passbolt_styleguide");
const LOCAL_DIR = path.join(ROOT, "dist/ui-local");
const LOCK_PATH = path.join(ROOT, "package-lock.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");

const options = parseOptions(process.argv.slice(2), {
  "--source": {key: "source"},
  "--exclusive": {key: "exclusive", type: "boolean"},
  "--checks": {key: "checks", type: "boolean"},
  "--docker": {key: "docker", type: "boolean"},
  "--repository": {key: "repository"},
});

if (options.help) {
  console.log(
    "Usage: npm run ui:local -- --exclusive [--source DIR] [--checks] [--docker] [--repository URL]",
  );
  process.exit(0);
}
if (!options.exclusive) {
  throw new Error(
    "Local UI acceptance replaces extension node_modules. Coordinate an exclusive build window first, then pass --exclusive.",
  );
}

const source = path.resolve(ROOT, options.source || DEFAULT_SOURCE);
const repository = options.repository || "https://github.com/Type-Delta/passbolt_styleguide.git";
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "passbolt-local-ui-"));
const hash = (value) => createHash("sha256").update(value).digest("hex");

let originalLock;
let mutatedLockHash;
let cleanedUp = false;

const restoreLockfile = () => {
  if (cleanedUp || !originalLock) {
    return;
  }
  cleanedUp = true;
  if (!fs.existsSync(LOCK_PATH)) {
    console.error(`[ui-local] package-lock.json disappeared; original backup: ${path.join(LOCAL_DIR, "package-lock.before.json")}`);
    process.exitCode = 1;
    return;
  }
  const current = fs.readFileSync(LOCK_PATH);
  const originalHash = hash(originalLock);
  const currentHash = hash(current);
  if (currentHash === originalHash) {
    return;
  }
  if (mutatedLockHash && currentHash === mutatedLockHash) {
    const temporaryPath = `${LOCK_PATH}.ui-local-restore`;
    fs.writeFileSync(temporaryPath, originalLock);
    fs.renameSync(temporaryPath, LOCK_PATH);
    console.log("[ui-local] Restored package-lock.json");
    return;
  }
  console.error(
    "[ui-local] package-lock.json changed after this process prepared its local artifact; refusing to overwrite another writer.",
  );
  console.error(`[ui-local] Original backup remains at ${path.join(LOCAL_DIR, "package-lock.before.json")}`);
  process.exitCode = 1;
};

process.once("exit", restoreLockfile);
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    console.error(`[ui-local] Received ${signal}; restoring local package state`);
    restoreLockfile();
    process.exit(exitCode);
  });
}

const run = (command, args, cwd = ROOT, env = process.env) => {
  const result = spawnSync(command, args, {cwd, stdio: "inherit", env});
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
};

const verifyLockfile = (artifact) => {
  const packageJson = readJson(PACKAGE_PATH);
  const lockfile = readJson(LOCK_PATH);
  const spec = "file:vendor/passbolt-styleguide.tgz";
  if (packageJson.dependencies["passbolt-styleguide"] !== spec) {
    throw new Error(`package.json must consume ${spec}`);
  }
  if (lockfile.packages?.[""]?.dependencies?.["passbolt-styleguide"] !== spec) {
    throw new Error("package-lock.json root dependency does not consume the local fork tarball");
  }
  const locked = lockfile.packages?.["node_modules/passbolt-styleguide"];
  if (locked?.resolved !== spec || locked?.integrity !== artifact.tarball.integrity) {
    throw new Error("package-lock.json does not pin the prepared local fork tarball");
  }
};

try {
  fs.mkdirSync(LOCAL_DIR, {recursive: true});
  const artifactOutput = path.join(temporaryDirectory, "artifact");
  run("npm", [
    "run",
    "pack:fork",
    "--",
    "--out",
    artifactOutput,
    "--repository",
    repository,
  ], source);

  const artifactManifestPath = path.join(artifactOutput, "passbolt-styleguide-artifact.json");
  assertFile(artifactManifestPath, "local styleguide artifact manifest");
  const artifact = readJson(artifactManifestPath);
  const artifactTarball = path.resolve(artifactOutput, artifact.tarball.file);
  assertFile(artifactTarball, "local styleguide tarball");
  if (sha256(artifactTarball) !== artifact.tarball.sha256 || sha512Integrity(artifactTarball) !== artifact.tarball.integrity) {
    throw new Error("Prepared local styleguide tarball does not match its artifact manifest");
  }

  const localArtifact = {
    ...artifact,
    localOnly: true,
    warning: "DEVELOPER-ONLY: this artifact was built from a mutable working tree and must never satisfy release verification.",
  };
  const localArtifactPath = path.join(LOCAL_DIR, "passbolt-styleguide-artifact.json");
  fs.writeFileSync(localArtifactPath, `${JSON.stringify(localArtifact, null, 2)}\n`);
  fs.copyFileSync(artifactTarball, path.join(LOCAL_DIR, "passbolt-styleguide.tgz"));
  fs.mkdirSync(path.join(ROOT, "vendor"), {recursive: true});
  fs.copyFileSync(artifactTarball, path.join(ROOT, "vendor/passbolt-styleguide.tgz"));

  originalLock = fs.readFileSync(LOCK_PATH);
  fs.writeFileSync(path.join(LOCAL_DIR, "package-lock.before.json"), originalLock);
  updateStyleguideLockfile({lockfilePath: LOCK_PATH, tarballPath: path.join(ROOT, "vendor/passbolt-styleguide.tgz")});
  mutatedLockHash = hash(fs.readFileSync(LOCK_PATH));
  verifyLockfile(artifact);

  run("npm", ["ci"]);
  verifyLockfile(artifact);

  const childEnv = {
    ...process.env,
    PASSBOLT_UI_LOCAL_ACCEPTANCE: "1",
    PASSBOLT_UI_LOCAL_ARTIFACT: path.relative(ROOT, localArtifactPath),
  };

  if (options.checks) {
    run("npm", ["run", "lint"], ROOT, childEnv);
    run("npm", ["run", "test:unit", "--", "--runInBand"], ROOT, childEnv);
  }
  run("npm", ["run", "release:build"], ROOT, childEnv);

  if (options.docker) {
    const shortCommit = artifact.source.commit.slice(0, 12);
    run(
      "deploy/passbolt-frontend/build-image.sh",
      ["--tag", `passbolt-frontend:local-ui-${shortCommit}`],
      ROOT,
      childEnv,
    );
  }

  console.log(`[ui-local] Working-tree UI artifact: ${localArtifactPath}`);
  console.log(`[ui-local] sha256=${artifact.tarball.sha256} dirty=${artifact.source.dirty}`);
  console.log("[ui-local] Release pin and release checksums were not updated.");
} finally {
  restoreLockfile();
  fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}
