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
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

export const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

export const sha256 = (filePath) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

export const sha512Integrity = (filePath) =>
  `sha512-${createHash("sha512").update(fs.readFileSync(filePath)).digest("base64")}`;

export const listFiles = (directory) => {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(directory);
  return files.sort();
};

export const relativeFileManifest = (rootDirectory, filePaths) =>
  filePaths.map((filePath) => ({
    path: path.relative(rootDirectory, filePath).split(path.sep).join("/"),
    sha256: sha256(filePath),
    bytes: fs.statSync(filePath).size,
  }));

export const parseOptions = (argv, definitions) => {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    const name = Object.keys(definitions).find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
    if (!name) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const definition = definitions[name];
    if (definition.type === "boolean") {
      options[definition.key] = true;
      continue;
    }

    const value = arg === name ? argv[++index] : arg.slice(name.length + 1);
    if (!value) {
      throw new Error(`${name} requires a value`);
    }
    options[definition.key] = value;
  }
  return options;
};

export const gitValue = (cwd, ...args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

export const assertFile = (filePath, label = filePath) => {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
};

export const updateStyleguideLockfile = ({lockfilePath, tarballPath}) => {
  const packedPackage = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {encoding: "utf8"}),
  );
  if (packedPackage.name !== "passbolt-styleguide") {
    throw new Error(`Unexpected styleguide package name: ${packedPackage.name}`);
  }
  const lockfile = readJson(lockfilePath);
  const spec = "file:vendor/passbolt-styleguide.tgz";
  lockfile.packages[""].dependencies["passbolt-styleguide"] = spec;
  lockfile.packages["node_modules/passbolt-styleguide"] = {
    version: packedPackage.version,
    resolved: spec,
    integrity: sha512Integrity(tarballPath),
    license: packedPackage.license,
    dependencies: packedPackage.dependencies,
    engines: packedPackage.engines,
    ...(packedPackage.bin ? {bin: packedPackage.bin} : {}),
  };
  writeJson(lockfilePath, lockfile);
};
