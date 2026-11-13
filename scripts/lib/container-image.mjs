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
import {readJson} from "./artifacts.mjs";

export const CONTAINER_IMAGE_RECEIPT = "CONTAINER-IMAGE.json";
export const RELEASE_TAG_PATTERN = /^fork-v[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/;
export const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const COMPONENT_PATTERN = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
export const DOCKERHUB_REPOSITORY_PATTERN = new RegExp(`^${COMPONENT_PATTERN}/${COMPONENT_PATTERN}$`);

export const assertReleaseTag = (tag) => {
  if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`Release tag must match fork-v* and Docker tag syntax: ${tag}`);
  }
  return tag;
};

export const assertRepository = (repository) => {
  if (typeof repository !== "string" || !DOCKERHUB_REPOSITORY_PATTERN.test(repository)) {
    throw new Error("DOCKERHUB_IMAGE must be a lowercase Docker Hub namespace/repository such as your-user/passbolt-frontend");
  }
  return repository;
};

export const assertSourceCommit = (commit) => {
  if (typeof commit !== "string" || !FULL_COMMIT_PATTERN.test(commit)) {
    throw new Error("Source commit must be a full 40-character lowercase Git commit SHA");
  }
  return commit;
};

export const assertDigest = (digest, label = "image digest") => {
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`Invalid ${label}: ${digest}`);
  }
  return digest;
};

export const parsePushDigest = (output, reference = "image") => {
  const matches = [...String(output).matchAll(/(?:^|\s)digest:\s*(sha256:[a-f0-9]{64})(?=\s|$)/gm)];
  const digests = [...new Set(matches.map((match) => match[1]))];
  if (digests.length !== 1) {
    throw new Error(`Expected one registry-confirmed digest from docker push ${reference}, found ${digests.length}`);
  }
  return digests[0];
};

export const containerImagePath = (directory) => path.join(directory, CONTAINER_IMAGE_RECEIPT);

export const readContainerImageReceipt = (directory) => {
  const filePath = containerImagePath(directory);
  return fs.existsSync(filePath) ? readJson(filePath) : null;
};

export const writeContainerImageReceipt = (directory, receipt) => {
  fs.mkdirSync(directory, {recursive: true});
  const filePath = containerImagePath(directory);
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
  return filePath;
};

const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "repository",
  "tag",
  "tags",
  "digest",
  "digestRef",
  "imageId",
  "platform",
  "extensionCommit",
  "ui",
  "manifestSha256",
  "baseImage",
]);

/**
 * Validates a receipt against the release build it is attached to. The
 * publisher writes it only after a registry pull and image verification.
 */
export const assertContainerImageReceipt = (receipt, expected) => {
  const fail = (message) => {
    throw new Error(`Invalid container image receipt: ${message}`);
  };
  if (!receipt || typeof receipt !== "object" || receipt.schemaVersion !== 1) fail("unsupported schema");
  const unexpected = Object.keys(receipt).filter((key) => !RECEIPT_KEYS.has(key));
  if (unexpected.length > 0) fail(`unexpected fields: ${unexpected.join(", ")}`);

  assertRepository(receipt.repository);
  assertReleaseTag(receipt.tag);
  assertSourceCommit(receipt.extensionCommit);
  assertDigest(receipt.digest);
  if (!DIGEST_PATTERN.test(receipt.imageId || "")) fail("image ID must be a sha256 digest");
  if (!/^[a-f0-9]{64}$/.test(receipt.manifestSha256 || "")) fail("manifest hash must be a SHA-256");
  if (typeof receipt.platform !== "string" || !/^[a-z0-9]+\/[a-z0-9]+$/.test(receipt.platform)) fail("invalid platform");
  if (receipt.digestRef !== `${receipt.repository}@${receipt.digest}`) fail("digest reference does not match repository and digest");

  const expectedTags = [`${receipt.repository}:${receipt.tag}`, `${receipt.repository}:${receipt.extensionCommit}`];
  if (!Array.isArray(receipt.tags) || receipt.tags.length !== expectedTags.length ||
      expectedTags.some((tag) => !receipt.tags.includes(tag))) {
    fail("tags must be exactly the release tag and the full source commit");
  }

  if (!receipt.ui || !FULL_COMMIT_PATTERN.test(receipt.ui.commit || "") ||
      typeof receipt.ui.version !== "string" || !/^[a-f0-9]{64}$/.test(receipt.ui.tarballSha256 || "")) {
    fail("invalid UI provenance");
  }
  if (!receipt.baseImage || typeof receipt.baseImage !== "object") fail("missing base image provenance");

  if (expected) {
    if (receipt.extensionCommit !== expected.extensionCommit) fail("extension commit does not match this build");
    if (receipt.ui.commit !== expected.ui.commit || receipt.ui.version !== expected.ui.version ||
        receipt.ui.tarballSha256 !== expected.ui.tarballSha256) {
      fail("UI provenance does not match this build");
    }
    if (receipt.manifestSha256 !== expected.manifestSha256) fail("server frontend manifest hash does not match this build");
    if (receipt.platform !== expected.baseImage.platform || receipt.baseImage.platform !== expected.baseImage.platform) {
      fail("platform does not match the verified base");
    }
    if (receipt.baseImage.reference !== expected.baseImage.reference) fail("base image reference does not match");
    if (receipt.baseImage.imageId !== expected.baseImage.imageId) fail("base image ID does not match");
  }
  return receipt;
};
