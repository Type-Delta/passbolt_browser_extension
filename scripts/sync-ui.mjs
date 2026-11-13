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
  parseOptions,
  readJson,
  sha256,
  sha512Integrity,
  updateStyleguideLockfile,
  writeJson,
} from "./lib/artifacts.mjs";

const PIN_PATH = path.join(ROOT, "ui-pin.json");
const LOCK_PATH = path.join(ROOT, "package-lock.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const DEFAULT_SOURCE = path.resolve(ROOT, "../passbolt_styleguide");
const DEFAULT_REPOSITORY = "https://github.com/Type-Delta/passbolt_styleguide.git";

const options = parseOptions(process.argv.slice(2), {
  "--source": {key: "source"},
  "--artifact": {key: "artifact"},
  "--write-pin": {key: "writePin", type: "boolean"},
  "--allow-dirty": {key: "allowDirty", type: "boolean"},
  "--repository": {key: "repository"},
});

if (options.help) {
  console.log("Usage: npm run ui:sync -- (--source DIR | --artifact MANIFEST) [--write-pin] [--allow-dirty] [--repository URL]");
  process.exit(0);
}

if (Boolean(options.source) === Boolean(options.artifact)) {
  throw new Error("Choose exactly one of --source DIR or --artifact MANIFEST");
}

const run = (command, args, cwd = ROOT, env = process.env) => {
  const result = spawnSync(command, args, {cwd, stdio: "inherit", env});
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
};

const assertPinnedToolchain = () => {
  const npmVersion = execFileSync("npm", ["--version"], {encoding: "utf8"}).trim();
  if (process.version !== "v22.14.0" || npmVersion !== "10.9.2") {
    throw new Error(
      `Clean pins must be produced with Node v22.14.0 and npm 10.9.2; found Node ${process.version} and npm ${npmVersion}`,
    );
  }
};

const buildCleanReconstruction = (source, artifact, temporaryDirectory) => {
  assertPinnedToolchain();
  const reconstructionPath = path.join(temporaryDirectory, "clean-source");
  const outputPath = path.join(temporaryDirectory, "clean-artifact");
  let worktreeCreated = false;
  try {
    run("git", ["worktree", "add", "--detach", reconstructionPath, artifact.source.commit], source);
    worktreeCreated = true;
    run("npm", ["ci"], reconstructionPath);
    run(
      "npm",
      [
        "run",
        "pack:fork",
        "--",
        "--out",
        outputPath,
        "--require-clean",
        "--require-pinned-toolchain",
        "--repository",
        artifact.source.repository,
      ],
      reconstructionPath,
    );
    const reconstructedManifest = path.join(outputPath, "passbolt-styleguide-artifact.json");
    assertFile(reconstructedManifest, "clean reconstruction manifest");
    const reconstructed = readJson(reconstructedManifest);
    const reconstructedTarball = path.resolve(outputPath, reconstructed.tarball.file);
    assertFile(reconstructedTarball, "clean reconstruction tarball");
    if (
      reconstructed.tarball.sha256 !== artifact.tarball.sha256 ||
      reconstructed.tarball.integrity !== artifact.tarball.integrity
    ) {
      throw new Error(
        "The clean reconstruction tarball does not match the working-tree artifact. Refusing to write ui-pin.json.",
      );
    }
    return reconstructed;
  } finally {
    if (worktreeCreated) {
      spawnSync("git", ["worktree", "remove", "--force", reconstructionPath], {cwd: source, stdio: "inherit"});
      spawnSync("git", ["worktree", "prune"], {cwd: source, stdio: "inherit"});
    }
  }
};

const copyTarball = (sourcePath, destinationPath) => {
  fs.mkdirSync(path.dirname(destinationPath), {recursive: true});
  const temporaryPath = `${destinationPath}.tmp`;
  fs.copyFileSync(sourcePath, temporaryPath);
  fs.renameSync(temporaryPath, destinationPath);
};

const verifyLockfile = (pin) => {
  const packageJson = readJson(PACKAGE_PATH);
  const lockfile = readJson(LOCK_PATH);
  const dependencySpec = packageJson.dependencies["passbolt-styleguide"];
  const rootDependency = lockfile.packages?.[""]?.dependencies?.["passbolt-styleguide"];
  const installedPackage = lockfile.packages?.["node_modules/passbolt-styleguide"];

  if (dependencySpec !== `file:${pin.tarball}`) {
    throw new Error(`package.json must consume ${pin.tarball}; found ${dependencySpec}`);
  }
  if (rootDependency !== dependencySpec) {
    throw new Error("package-lock.json root dependency does not match package.json");
  }
  if (installedPackage?.resolved !== dependencySpec) {
    throw new Error("package-lock.json must resolve passbolt-styleguide from the vendored fork tarball");
  }
  if (installedPackage?.integrity !== pin.tarballIntegrity) {
    throw new Error("package-lock.json integrity does not match ui-pin.json");
  }
};

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "passbolt-ui-artifact-"));
try {
  let artifactManifestPath;
  if (options.source) {
    const source = path.resolve(ROOT, options.source);
    const repository = options.repository || DEFAULT_REPOSITORY;
    const packArgs = [
      "run",
      "pack:fork",
      "--",
      "--out",
      temporaryDirectory,
      "--repository",
      repository,
    ];
    if (!options.allowDirty) {
      packArgs.push("--require-clean", "--require-pinned-toolchain");
    }
    run("npm", packArgs, source);
    artifactManifestPath = path.join(temporaryDirectory, "passbolt-styleguide-artifact.json");
  } else {
    artifactManifestPath = path.resolve(ROOT, options.artifact);
  }

  assertFile(artifactManifestPath, "styleguide artifact manifest");
  const artifact = readJson(artifactManifestPath);
  const tarballPath = path.resolve(path.dirname(artifactManifestPath), artifact.tarball.file);
  assertFile(tarballPath, "styleguide tarball");

  const actualSha256 = sha256(tarballPath);
  const actualIntegrity = sha512Integrity(tarballPath);
  if (actualSha256 !== artifact.tarball.sha256) {
    throw new Error(`Tarball SHA-256 mismatch: expected ${artifact.tarball.sha256}, found ${actualSha256}`);
  }
  if (actualIntegrity !== artifact.tarball.integrity) {
    throw new Error("Tarball npm integrity does not match the styleguide artifact manifest");
  }
  if (artifact.name !== "passbolt-styleguide") {
    throw new Error(`Unexpected styleguide package name: ${artifact.name}`);
  }

  const repository = options.repository || DEFAULT_REPOSITORY;
  const candidatePin = {
    schemaVersion: 1,
    repository,
    commit: artifact.source.commit,
    ref: artifact.source.ref,
    version: artifact.version,
    sourceDirty: artifact.source.dirty,
    tarball: "vendor/passbolt-styleguide.tgz",
    tarballSha256: artifact.tarball.sha256,
    tarballIntegrity: artifact.tarball.integrity,
  };

  if (options.writePin && options.allowDirty) {
    throw new Error("Dirty sources cannot be pinned. Use `npm run ui:local -- --exclusive` for a developer-only acceptance build.");
  }

  if (options.writePin) {
    if (candidatePin.sourceDirty) {
      throw new Error("Refusing to pin a dirty UI source tree; commit the styleguide first");
    }
    if (!options.allowDirty) {
      console.log("[ui-sync] Rebuilding from a fresh worktree to verify byte-identical artifact reconstruction");
      buildCleanReconstruction(path.resolve(ROOT, options.source), artifact, temporaryDirectory);
    }
    copyTarball(tarballPath, path.join(ROOT, candidatePin.tarball));
    writeJson(PIN_PATH, candidatePin);
    updateStyleguideLockfile({
      lockfilePath: LOCK_PATH,
      tarballPath: path.join(ROOT, candidatePin.tarball),
    });
    verifyLockfile(candidatePin);
  } else {
    assertFile(PIN_PATH, "ui-pin.json");
    const pin = readJson(PIN_PATH);
    if (pin.sourceDirty && !options.allowDirty) {
      throw new Error(
        "ui-pin.json was generated from a dirty styleguide checkout; commit the final UI and rerun `npm run ui:sync -- --source ../passbolt_styleguide --write-pin`",
      );
    }
    for (const key of ["commit", "version", "tarballSha256", "tarballIntegrity"]) {
      if (candidatePin[key] !== pin[key]) {
        throw new Error(`UI artifact ${key} does not match ui-pin.json; refresh the pin after the final UI commit`);
      }
    }
    if (options.repository && pin.repository !== options.repository) {
      throw new Error(`UI artifact repository does not match ui-pin.json: ${options.repository}`);
    }
    copyTarball(tarballPath, path.join(ROOT, pin.tarball));
    verifyLockfile(pin);
    console.log(`[ui-sync] Verified ${pin.version} from ${pin.commit}`);
  }

  console.log(`[ui-sync] Staged ${candidatePin.tarball}`);
  console.log(`[ui-sync] sha256=${candidatePin.tarballSha256}`);
  console.log(`[ui-sync] sourceDirty=${candidatePin.sourceDirty}`);
} finally {
  fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}
