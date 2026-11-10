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
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {ROOT, readJson, sha256} from "./artifacts.mjs";

export const APP_ROOT = "/usr/share/php/passbolt";
export const EMBEDDED_MANIFEST = "webroot/.passbolt-fork-frontend.json";
export const INHERITED_ICON_PATHS = [
  "webroot/favicon.png",
  "webroot/apple-touch-icon-114x114-precomposed.png",
  "webroot/apple-touch-icon-57x57-precomposed.png",
  "webroot/apple-touch-icon-72x72-precomposed.png",
  "webroot/apple-touch-icon-precomposed.png",
  "webroot/apple-touch-icon.png",
];
export const TEMPLATE_PATHS = [
  "templates/Auth/triage.php",
  "templates/Home/api_app.php",
  "templates/Home/api_ext_app.php",
  "templates/Setup/SetupStart/start.php",
  "templates/Setup/RecoverStart/start.php",
  "plugins/PassboltCe/MultiFactorAuthentication/templates/layout/mfa_verify.php",
];
export const base = readJson(path.join(ROOT, "deploy/passbolt-frontend/base-image.json"));
if (!/^passbolt\/passbolt@sha256:[a-f0-9]{64}$/.test(base.reference) ||
    !/^sha256:[a-f0-9]{64}$/.test(base.imageId) ||
    JSON.stringify(Object.keys(base.templateSha256).sort()) !== JSON.stringify([...TEMPLATE_PATHS].sort())) {
  throw new Error("Invalid immutable base pin or template allowlist");
}
export const frontendRevision = (tarballSha256) => {
  if (!/^[a-f0-9]{64}$/.test(tarballSha256)) throw new Error("Invalid UI tarball SHA-256");
  return `ui-${tarballSha256}`;
};
export const assertOverlayPath = (file) => {
  if (
    typeof file !== "string" ||
    !/^[A-Za-z0-9_./-]+$/.test(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..") ||
    INHERITED_ICON_PATHS.includes(file) ||
    !(file.startsWith("webroot/") || TEMPLATE_PATHS.includes(file))
  ) {
    throw new Error(`Disallowed overlay path: ${file}`);
  }
};
export const assertManifest = (manifest) => {
  if (manifest.schemaVersion !== 2 || manifest.server.baseImage !== base.reference ||
      manifest.server.baseImageId !== base.imageId || manifest.server.appRoot !== APP_ROOT ||
      manifest.server.webroot !== `${APP_ROOT}/webroot` ||
      manifest.server.frontendRevision !== frontendRevision(manifest.ui.tarballSha256) ||
      JSON.stringify(manifest.server.baseTemplateSha256) !== JSON.stringify(base.templateSha256)) {
    throw new Error("Stale frontend manifest: base pin, revision, or overlay schema mismatch");
  }
  if (typeof manifest.ui.localOnly !== "boolean" || (!manifest.ui.localOnly && manifest.ui.dirty !== false)) {
    throw new Error("Invalid frontend localOnly/dirty provenance");
  }
  const seen = new Set();
  for (const file of manifest.files) {
    assertOverlayPath(file.path);
    if (file.path === EMBEDDED_MANIFEST || seen.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Invalid overlay manifest entry: ${file.path}`);
    }
    seen.add(file.path);
  }
  for (const file of manifest.files.filter((entry) => TEMPLATE_PATHS.includes(entry.path))) {
    const source = path.join(ROOT, "deploy/passbolt-frontend", file.path);
    if (sha256(source) !== base.templateSha256[file.path]) throw new Error(`Reviewed template drift: ${file.path}`);
    const output = Buffer.from(reviseTemplate(fs.readFileSync(source, "utf8"), manifest.server.frontendRevision));
    if (file.sha256 !== createHash("sha256").update(output).digest("hex") || file.bytes !== output.length) {
      throw new Error(`Unexpected template edit: ${file.path}`);
    }
  }
  if (!manifest.files.some((file) => file.path.startsWith("webroot/")) ||
      TEMPLATE_PATHS.some((file) => !seen.has(file))) throw new Error("Incomplete frontend overlay");
};

// Reviewed stock copies must match both the pin and the immutable base image.
export const stageTemplates = (rootfs, revision) => {
  const actual = execFileSync("docker", ["image", "inspect", base.reference, "--format", "{{.Id}}"], {encoding: "utf8"}).trim();
  if (actual !== base.imageId) throw new Error("Pinned base image ID mismatch");
  const sources = TEMPLATE_PATHS.map((file) => {
    const source = fs.readFileSync(path.join(ROOT, "deploy/passbolt-frontend", file));
    if (createHash("sha256").update(source).digest("hex") !== base.templateSha256[file]) {
      throw new Error(`Reviewed base template drift: ${file}`);
    }
    return source.toString("utf8");
  });
  const checksums = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sha256sum",
    base.reference, ...TEMPLATE_PATHS.map((file) => `${APP_ROOT}/${file}`)], {encoding: "utf8"});
  for (const file of TEMPLATE_PATHS) {
    if (!checksums.split("\n").includes(`${base.templateSha256[file]}  ${APP_ROOT}/${file}`)) {
      throw new Error(`Immutable base template drift: ${file}`);
    }
  }
  for (const [index, file] of TEMPLATE_PATHS.entries()) {
    const output = reviseTemplate(sources[index], revision);
    const destination = path.join(rootfs, file);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.writeFileSync(destination, output);
  }
};

// Keep the backend version assignment and all non-asset PHP behavior intact.
export const reviseTemplate = (source, revision) => {
  if (!/^ui-[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid frontend revision");
  return source
    .replace(/('(?:(?:\/js\/app\/)[^']+\?v=)'\s*\.\s*)(?:\$version|Configure::read\('passbolt\.version'\))/g, `$1'${revision}'`)
    .replace(/('cache-version'\s*=>\s*)(?:\$version|Configure::read\('passbolt\.version'\))/g, `$1'${revision}'`);
};

export const validateContext = (directory) => {
  const manifest = readJson(path.join(directory, "MANIFEST.json"));
  assertManifest(manifest);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const rootfs = path.join(directory, "rootfs");
  const found = new Set();
  const visit = (current, relative = "") => {
    const directoryStat = fs.lstatSync(current);
    if (!directoryStat.isDirectory()) throw new Error(`Unsafe overlay directory: ${current}`);
    if ((directoryStat.mode & 0o7777) !== 0o755) {
      throw new Error(`Invalid public directory mode: ${current}`);
    }
    for (const name of fs.readdirSync(current)) {
      const file = relative ? `${relative}/${name}` : name;
      const absolute = path.join(current, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in overlay: ${file}`);
      if (stat.isDirectory()) {
        if (file !== "webroot" && !file.startsWith("webroot/") &&
            !TEMPLATE_PATHS.some((template) => template.startsWith(`${file}/`))) {
          throw new Error(`Disallowed overlay directory: ${file}`);
        }
        visit(absolute, file);
      } else {
        assertOverlayPath(file);
        if (!stat.isFile()) throw new Error(`Non-file overlay entry: ${file}`);
        if ((stat.mode & 0o7777) !== 0o644) {
          throw new Error(`Invalid public file mode: ${file}`);
        }
        if (file !== EMBEDDED_MANIFEST) {
          const entry = expected.get(file);
          if (!entry || entry.sha256 !== sha256(absolute) || entry.bytes !== stat.size) {
            throw new Error(`Overlay content mismatch: ${file}`);
          }
          found.add(file);
        }
      }
    }
  };
  visit(rootfs);
  if (found.size !== expected.size) throw new Error("Missing overlay files");
  if (!fs.readFileSync(path.join(directory, "MANIFEST.json")).equals(fs.readFileSync(path.join(rootfs, EMBEDDED_MANIFEST)))) {
    throw new Error("Embedded frontend manifest mismatch");
  }
  const dockerfile = fs.readFileSync(path.join(directory, "Dockerfile"));
  if (!dockerfile.equals(fs.readFileSync(path.join(ROOT, "deploy/passbolt-frontend/Dockerfile")))) {
    throw new Error("Stale or modified context Dockerfile");
  }
  return manifest;
};
