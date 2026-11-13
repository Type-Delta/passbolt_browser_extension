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
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {ROOT} from "./lib/artifacts.mjs";

const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: ROOT, stdio: "inherit", env: process.env});
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
};

for (const directory of ["dist/firefox", "dist/chromium-mv3", "dist/server-frontend", "dist/release"]) {
  fs.rmSync(path.join(ROOT, directory), {recursive: true, force: true});
}

run("node", ["scripts/verify-ui.mjs"]);
run("npm", ["run", "build:firefox"]);
run("npm", ["run", "build:chromium-mv3"]);
run("node", ["scripts/build-server-assets.mjs"]);
run("node", ["scripts/package-release.mjs"]);
