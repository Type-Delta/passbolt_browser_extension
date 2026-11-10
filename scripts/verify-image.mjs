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
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {ROOT, assertFile, readJson} from "./lib/artifacts.mjs";
import {APP_ROOT, EMBEDDED_MANIFEST, TEMPLATE_PATHS, assertManifest, base} from "./lib/frontend-overlay.mjs";

const image = process.argv[2];
const manifestPath = path.resolve(ROOT, process.argv[3] || "dist/server-frontend/MANIFEST.json");
if (!image) throw new Error("Usage: node scripts/verify-image.mjs IMAGE [MANIFEST]");
assertFile(manifestPath, "server frontend manifest");
const manifest = readJson(manifestPath);
assertManifest(manifest);
const docker = (args) => execFileSync("docker", args, {encoding: "utf8"}).trim();
const inspect = (reference) => JSON.parse(docker(["image", "inspect", reference]))[0];
const stock = inspect(base.reference);
const target = inspect(image);
if (stock.Id !== base.imageId) throw new Error("Pinned base image ID mismatch");
for (const key of ["Entrypoint", "Cmd", "WorkingDir", "User", "Volumes", "ExposedPorts", "Env", "Healthcheck"]) {
  if (JSON.stringify(stock.Config[key]) !== JSON.stringify(target.Config[key])) {
    throw new Error(`Image changed inherited runtime configuration: ${key}`);
  }
}
if (target.RootFS.Layers.length !== stock.RootFS.Layers.length + 1 ||
    stock.RootFS.Layers.some((layer, index) => layer !== target.RootFS.Layers[index])) {
  throw new Error("Expected unchanged base layers and exactly one frontend layer");
}

// PHP checks every path component so hashes cannot silently follow symlinks.
const hashes = JSON.parse(docker([
  "run", "--rm", "--network", "none", "--user", "www-data", "--entrypoint", "php", image, "-r", `
  $root = $argv[1]; $result = [];
  foreach (array_slice($argv, 2) as $file) {
    $current = '';
    foreach (explode('/', ltrim($root . '/' . $file, '/')) as $part) {
      $current .= '/' . $part;
      if (is_link($current)) {fwrite(STDERR, 'Symlink in overlay path'); exit(1);}
    }
    if (!is_file($current) || !is_readable($current)) {fwrite(STDERR, 'Missing or unreadable overlay file'); exit(1);}
    $result[$file] = ['sha256' => hash_file('sha256', $current), 'bytes' => filesize($current)];
  }
  echo json_encode($result);`, APP_ROOT, ...manifest.files.map((file) => file.path), EMBEDDED_MANIFEST,
]));
for (const file of manifest.files) {
  if (hashes[file.path].sha256 !== file.sha256 || hashes[file.path].bytes !== file.bytes) {
    throw new Error(`Image content mismatch for ${file.path}`);
  }
}
const embedded = execFileSync("docker", ["run", "--rm", "--network", "none", "--user", "www-data", "--entrypoint", "cat", image,
  `${APP_ROOT}/${EMBEDDED_MANIFEST}`]);
if (!embedded.equals(fs.readFileSync(manifestPath))) throw new Error("Embedded frontend manifest mismatch");
for (const file of TEMPLATE_PATHS) {
  docker(["run", "--rm", "--network", "none", "--user", "www-data", "--entrypoint", "php", image, "-l", `${APP_ROOT}/${file}`]);
}
console.log(`[verify-image] ${image}: ${manifest.files.length} file hashes/sizes, full embedded manifest, ${TEMPLATE_PATHS.length} PHP syntax checks pass as www-data`);
console.log(`[verify-image] exact base ${stock.Id}; one frontend layer; inherited runtime unchanged`);
console.log(`[verify-image] revision=${manifest.server.frontendRevision} localOnly=${manifest.ui.localOnly}`);
