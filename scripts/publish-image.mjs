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
import {pathToFileURL} from "node:url";
import {ROOT, assertFile, parseOptions, readJson, sha256} from "./lib/artifacts.mjs";
import {assertContainerImageReceipt, assertDigest, assertReleaseTag, assertRepository, assertSourceCommit,
  containerImagePath, DIGEST_PATTERN, parsePushDigest, writeContainerImageReceipt} from "./lib/container-image.mjs";
import {base, validateContext} from "./lib/frontend-overlay.mjs";

const runProcess = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options});
  } catch (error) {
    const detail = [error?.stderr, error?.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args[0]} failed${detail ? `: ${detail}` : `: ${error.message}`}`);
  }
};

const defaultDependencies = {
  docker: (args) => runProcess("docker", args),
  git: (args) => runProcess("git", args).trim(),
  validateContext,
  verifyImage: (reference, manifestPath) => {
    runProcess(process.execPath, [path.join(ROOT, "scripts/verify-image.mjs"), reference, manifestPath],
      {stdio: "inherit"});
  },
};

const inspectImage = (docker, reference) => {
  const [image] = JSON.parse(docker(["image", "inspect", reference]));
  if (!image) throw new Error(`Docker has no image metadata for ${reference}`);
  return image;
};

const readImageMetadata = (contextDirectory) => {
  const filePath = path.join(contextDirectory, "IMAGE.txt");
  assertFile(filePath, "frontend image metadata");
  const entries = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid frontend image metadata line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  const metadata = Object.fromEntries(entries);
  if (Object.keys(metadata).length !== entries.length) throw new Error("Duplicate frontend image metadata key");
  return metadata;
};

const assertImageIdentity = (image, manifest, packageVersion) => {
  const labels = image.Config?.Labels || {};
  const platform = `${image.Os}/${image.Architecture}`;
  if (platform !== base.platform) throw new Error(`Image platform ${platform} does not match the verified ${base.platform} base`);
  if (!DIGEST_PATTERN.test(image.Id || "")) throw new Error(`Image ID is not a sha256 digest: ${image.Id}`);
  if (labels["com.passbolt.fork.ui.commit"] !== manifest.ui.commit) {
    throw new Error("Image UI commit label does not match the verified frontend manifest");
  }
  if (labels["com.passbolt.fork.ui.version"] !== manifest.ui.version) {
    throw new Error("Image UI version label does not match the verified frontend manifest");
  }
  if (labels["com.passbolt.fork.extension.version"] !== packageVersion) {
    throw new Error("Image extension version label does not match package.json");
  }
  return platform;
};

/**
 * Publishes the already-built and locally verified frontend image. Authentication
 * is supplied by the preceding Docker login step; no token argument is accepted.
 */
export const publishImage = (options, dependencies = {}) => {
  const {docker, git, validateContext: validate, verifyImage, pin: readPin} = {
    ...defaultDependencies,
    pin: () => readJson(path.join(ROOT, "ui-pin.json")),
    ...dependencies,
  };
  const repository = assertRepository(options.repository);
  const tag = assertReleaseTag(options.tag);
  const sourceCommit = assertSourceCommit(options.sourceCommit);
  if (!options.image || /[@\s]/.test(options.image)) throw new Error("A local image tag is required");

  const contextDirectory = path.resolve(ROOT, options.context || "dist/server-frontend");
  const manifestPath = path.resolve(ROOT, options.manifest || path.join(contextDirectory, "MANIFEST.json"));
  const outputDirectory = path.resolve(ROOT, options.out || "dist/release");
  const receiptPath = containerImagePath(outputDirectory);
  fs.rmSync(receiptPath, {force: true});

  try {
    const head = git(["rev-parse", "HEAD"]);
    if (head !== sourceCommit) {
      throw new Error(`Requested source commit ${sourceCommit} is not the checked-out HEAD ${head}`);
    }
    let tagCommit = null;
    try {
      tagCommit = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]) || null;
    } catch {
      tagCommit = null;
    }
    if (tagCommit && tagCommit !== sourceCommit) {
      throw new Error(`Release tag ${tag} points to ${tagCommit}, not the requested source commit ${sourceCommit}`);
    }
    if (!tagCommit && options.requireExistingTag) {
      throw new Error(`Release tag ${tag} does not exist in the checked-out Git repository`);
    }

    assertFile(manifestPath, "server frontend manifest");
    const builtManifest = validate(contextDirectory);
    const manifest = readJson(manifestPath);
    if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) {
      throw new Error("Server frontend manifest does not match the verified build context");
    }
    if (manifest.ui.localOnly !== false) throw new Error("Refusing to publish a localOnly frontend image");
    if (manifest.ui.dirty !== false) throw new Error("Refusing to publish a frontend image built from a dirty UI tree");
    if (manifest.server.baseImage !== base.reference || manifest.server.baseImageId !== base.imageId) {
      throw new Error("Frontend manifest does not use the pinned immutable base image");
    }
    if (manifest.server.frontendRevision !== `ui-${manifest.ui.tarballSha256}`) {
      throw new Error("Frontend manifest revision does not match the UI tarball hash");
    }
    const pin = readPin();
    if (pin.sourceDirty !== false) throw new Error("Refusing to publish a frontend image from a dirty UI pin");
    if (pin.repository !== manifest.ui.repository || pin.commit !== manifest.ui.commit ||
        pin.version !== manifest.ui.version || pin.tarballSha256 !== manifest.ui.tarballSha256) {
      throw new Error("UI pin provenance does not match the verified frontend manifest");
    }

    const packageVersion = readJson(path.join(ROOT, "package.json")).version;
    const metadata = readImageMetadata(contextDirectory);
    if (metadata.image !== options.image) throw new Error("Built image metadata does not name the image being published");
    if (metadata.localOnly !== "false") throw new Error("Built image metadata marks the image localOnly");
    if (metadata.base !== base.reference) throw new Error("Built image metadata does not use the pinned base");
    if (metadata.uiCommit !== manifest.ui.commit || metadata.uiVersion !== manifest.ui.version) {
      throw new Error("Built image metadata UI provenance does not match the frontend manifest");
    }
    if (metadata.extensionVersion !== packageVersion) {
      throw new Error("Built image metadata extension version does not match package.json");
    }

    const localImage = inspectImage(docker, options.image);
    assertImageIdentity(localImage, manifest, packageVersion);

    const releaseReference = `${repository}:${tag}`;
    const commitReference = `${repository}:${sourceCommit}`;
    docker(["tag", options.image, releaseReference]);
    docker(["tag", options.image, commitReference]);

    const releaseDigest = parsePushDigest(docker(["push", releaseReference]), releaseReference);
    const commitDigest = parsePushDigest(docker(["push", commitReference]), commitReference);
    if (releaseDigest !== commitDigest) {
      throw new Error("Registry returned different digests for the release and source-commit tags");
    }
    const digestRef = `${repository}@${assertDigest(releaseDigest, "registry digest")}`;
    const repoDigests = JSON.parse(docker(["image", "inspect", "--format", "{{json .RepoDigests}}", releaseReference]));
    if (!Array.isArray(repoDigests) || !repoDigests.includes(digestRef)) {
      throw new Error("Pushed release tag does not resolve to the registry-confirmed digest locally");
    }

    docker(["pull", digestRef]);
    const pulledImage = inspectImage(docker, digestRef);
    if (pulledImage.Id !== localImage.Id) throw new Error("Pulled digest image ID does not match the verified local image");
    assertImageIdentity(pulledImage, manifest, packageVersion);
    if (!Array.isArray(pulledImage.RepoDigests) || !pulledImage.RepoDigests.includes(digestRef)) {
      throw new Error("Pulled image is not bound to the registry digest reference");
    }

    const manifestSha256 = sha256(manifestPath);
    verifyImage(digestRef, manifestPath);
    if (sha256(manifestPath) !== manifestSha256) {
      throw new Error("Server frontend manifest changed during registry verification");
    }

    const receipt = {
      schemaVersion: 1,
      repository,
      tag,
      tags: [releaseReference, commitReference],
      digest: releaseDigest,
      digestRef,
      imageId: localImage.Id,
      platform: base.platform,
      extensionCommit: sourceCommit,
      ui: {
        version: manifest.ui.version,
        commit: manifest.ui.commit,
        tarballSha256: manifest.ui.tarballSha256,
      },
      manifestSha256,
      baseImage: {
        reference: base.reference,
        imageId: base.imageId,
        platform: base.platform,
      },
    };
    assertContainerImageReceipt(receipt, {
      extensionCommit: sourceCommit,
      ui: manifest.ui,
      manifestSha256,
      baseImage: base,
    });
    writeContainerImageReceipt(outputDirectory, receipt);
    return {receipt, receiptPath};
  } catch (error) {
    fs.rmSync(receiptPath, {force: true});
    throw error;
  }
};

const isMain = () => Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain()) {
  let options;
  try {
    options = parseOptions(process.argv.slice(2), {
      "--image": {key: "image"},
      "--repository": {key: "repository"},
      "--tag": {key: "tag"},
      "--source-commit": {key: "sourceCommit"},
      "--context": {key: "context"},
      "--manifest": {key: "manifest"},
      "--out": {key: "out"},
      "--require-existing-tag": {key: "requireExistingTag", type: "boolean"},
    });
    if (options.help) {
      console.log("Usage: node scripts/publish-image.mjs --image LOCAL_TAG --repository NAMESPACE/REPO --tag fork-vTAG " +
        "--source-commit FULL_SHA [--context DIR] [--manifest FILE] [--out DIR] [--require-existing-tag]");
      process.exit(0);
    }
    const {receipt} = publishImage(options);
    console.log(`[publish-image] published ${receipt.digestRef}`);
    console.log(`[publish-image] tags=${receipt.tags.join(",")} imageId=${receipt.imageId}`);
  } catch (error) {
    console.error(`[publish-image] ${error.message}`);
    process.exitCode = 1;
  }
}
