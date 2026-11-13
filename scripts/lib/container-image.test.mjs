import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {ROOT, readJson} from "./artifacts.mjs";
import {
  CONTAINER_IMAGE_RECEIPT,
  assertContainerImageReceipt,
  assertReleaseTag,
  assertRepository,
  assertSourceCommit,
  containerImagePath,
  parsePushDigest,
  readContainerImageReceipt,
} from "./container-image.mjs";
import {base} from "./frontend-overlay.mjs";
import {publishImage} from "../publish-image.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const OTHER_COMMIT = "f".repeat(40);
const UI_COMMIT = "b".repeat(40);
const TARBALL_SHA256 = "c".repeat(64);
const DIGEST = `sha256:${"d".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"9".repeat(64)}`;
const IMAGE_ID = `sha256:${"e".repeat(64)}`;
const REPOSITORY = "your-user/passbolt-frontend";
const RELEASE_TAG = "fork-v5.17.1-multi-account.3";
const LOCAL_IMAGE = "passbolt-frontend:ci-aaaaaaaaaaaa";
const PACKAGE_VERSION = readJson(path.join(ROOT, "package.json")).version;

const manifest = () => ({
  schemaVersion: 2,
  localOnly: false,
  ui: {
    repository: "https://github.com/your-user/passbolt_styleguide.git",
    version: "5.16.0",
    commit: UI_COMMIT,
    tarballSha256: TARBALL_SHA256,
    localOnly: false,
    dirty: false,
  },
  server: {
    baseImage: base.reference,
    baseImageId: base.imageId,
    frontendRevision: `ui-${TARBALL_SHA256}`,
  },
  files: [{path: "webroot/fork-test.js", sha256: "0".repeat(64), bytes: 1}],
});

const image = (overrides = {}) => ({
  Id: IMAGE_ID,
  Os: "linux",
  Architecture: "amd64",
  RepoDigests: [],
  Config: {
    Labels: {
      "com.passbolt.fork.ui.commit": UI_COMMIT,
      "com.passbolt.fork.ui.version": "5.16.0",
      "com.passbolt.fork.extension.version": PACKAGE_VERSION,
    },
  },
  ...overrides,
});

const workspace = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-image-test-"));
  const context = path.join(directory, "context");
  const out = path.join(directory, "release");
  fs.mkdirSync(context);
  fs.writeFileSync(path.join(context, "MANIFEST.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
  fs.writeFileSync(
    path.join(context, "IMAGE.txt"),
    [
      `image=${LOCAL_IMAGE}`,
      `base=${base.reference}`,
      "uiVersion=5.16.0",
      `uiCommit=${UI_COMMIT}`,
      `extensionVersion=${PACKAGE_VERSION}`,
      "localOnly=false",
      "",
    ].join("\n"),
  );
  return {directory, context, out, manifestPath: path.join(context, "MANIFEST.json")};
};

const options = (files, overrides = {}) => ({
  image: LOCAL_IMAGE,
  repository: REPOSITORY,
  tag: RELEASE_TAG,
  sourceCommit: SOURCE_COMMIT,
  context: files.context,
  manifest: files.manifestPath,
  out: files.out,
  ...overrides,
});

const harness = ({
  tagCommit = SOURCE_COMMIT,
  firstDigest = DIGEST,
  secondDigest = DIGEST,
  localImage = image(),
  pulledImage = image({RepoDigests: [`${REPOSITORY}@${DIGEST}`]}),
  repoDigests = [`${REPOSITORY}@${DIGEST}`],
  failOn = {},
  pin = {
    repository: "https://github.com/your-user/passbolt_styleguide.git",
    commit: UI_COMMIT,
    version: "5.16.0",
    tarballSha256: TARBALL_SHA256,
    sourceDirty: false,
  },
} = {}) => {
  const calls = [];
  const verifyCalls = [];
  let pushes = 0;
  const docker = (args) => {
    calls.push(args);
    if (failOn[args[0]]) throw new Error(failOn[args[0]]);
    if (args[0] === "image" && args[1] === "inspect") {
      if (args[2] === "--format") return JSON.stringify(repoDigests);
      return JSON.stringify([args[2] === LOCAL_IMAGE ? localImage : pulledImage]);
    }
    if (args[0] === "tag") return "";
    if (args[0] === "push") {
      const digest = pushes++ === 0 ? firstDigest : secondDigest;
      return `${args[1]}: digest: ${digest} size: 42`;
    }
    if (args[0] === "pull") return `Digest: ${DIGEST}`;
    throw new Error(`Unexpected docker call: ${args.join(" ")}`);
  };
  const git = (args) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return SOURCE_COMMIT;
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (!tagCommit) throw new Error("unknown revision");
      return tagCommit;
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };
  return {
    calls,
    verifyCalls,
    dependencies: {
      docker,
      git,
      validateContext: () => manifest(),
      verifyImage: (reference, manifestPath) => verifyCalls.push([reference, manifestPath]),
      pin: () => pin,
    },
  };
};

test("publisher CLI exposes help and rejects invalid input before Docker", () => {
  const cli = path.join(ROOT, "scripts/publish-image.mjs");
  const help = spawnSync(process.execPath, [cli, "--help"], {encoding: "utf8"});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/publish-image\.mjs/);

  const invalid = spawnSync(process.execPath, [
    cli,
    "--image", LOCAL_IMAGE,
    "--repository", "Type-Delta/passbolt-frontend",
    "--tag", "latest",
    "--source-commit", "abc",
  ], {encoding: "utf8"});
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /DOCKERHUB_IMAGE/);
});

test("release inputs accept fork-v tags and Docker Hub repositories only", () => {
  assert.equal(assertReleaseTag(RELEASE_TAG), RELEASE_TAG);
  assert.equal(assertRepository(REPOSITORY), REPOSITORY);
  assert.equal(assertSourceCommit(SOURCE_COMMIT), SOURCE_COMMIT);
  for (const tag of ["latest", "v5.17.1", "fork-v", "fork-v5.17.1 multi"]) {
    assert.throws(() => assertReleaseTag(tag), /Release tag/);
  }
  for (const repository of ["passbolt-frontend", "Type-Delta/passbolt-frontend", "your-user/passbolt-frontend:tag"]) {
    assert.throws(() => assertRepository(repository), /DOCKERHUB_IMAGE/);
  }
  assert.throws(() => assertSourceCommit("a".repeat(12)), /40-character/);
});

test("push digest parsing requires one registry-confirmed digest", () => {
  assert.equal(parsePushDigest(`x: digest: ${DIGEST} size: 10`), DIGEST);
  assert.throws(() => parsePushDigest(""), /Expected one/);
  assert.throws(() => parsePushDigest(`digest: ${DIGEST}\ndigest: ${OTHER_DIGEST}`), /Expected one/);
});

test("publishes the verified local image and writes a matching receipt", () => {
  const files = workspace();
  const {calls, verifyCalls, dependencies} = harness();
  const {receipt, receiptPath} = publishImage(options(files), dependencies);

  assert.equal(receiptPath, containerImagePath(files.out));
  assert.equal(receipt.digestRef, `${REPOSITORY}@${DIGEST}`);
  assert.deepEqual(receipt.tags, [`${REPOSITORY}:${RELEASE_TAG}`, `${REPOSITORY}:${SOURCE_COMMIT}`]);
  assert.equal(receipt.imageId, IMAGE_ID);
  assert.equal(receipt.extensionCommit, SOURCE_COMMIT);
  assert.equal(receipt.ui.commit, UI_COMMIT);
  assert.equal(receipt.ui.tarballSha256, TARBALL_SHA256);
  assert.equal(receipt.baseImage.reference, base.reference);
  assert.deepEqual(verifyCalls, [[`${REPOSITORY}@${DIGEST}`, files.manifestPath]]);
  assert.deepEqual(
    calls.filter((call) => call[0] === "push").map((call) => call[1]),
    [`${REPOSITORY}:${RELEASE_TAG}`, `${REPOSITORY}:${SOURCE_COMMIT}`],
  );
  assert.deepEqual(readContainerImageReceipt(files.out), receipt);
  assert.ok(calls.every((call) => !call.includes("--password") && call[0] !== "login"));
  assert.ok(!JSON.stringify(receipt).toLowerCase().includes("token"));
});

test("manual dispatch may create a missing release tag at the checked-out source", () => {
  const files = workspace();
  const {dependencies} = harness({tagCommit: null});
  assert.doesNotThrow(() => publishImage(options(files), dependencies));
});

test("rejects an existing release tag that points at another commit", () => {
  const files = workspace();
  const {calls, dependencies} = harness({tagCommit: OTHER_COMMIT});
  assert.throws(() => publishImage(options(files), dependencies), /points to .*not the requested source commit/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(containerImagePath(files.out)), false);
});

test("tag events require the release tag to exist", () => {
  const files = workspace();
  const {dependencies} = harness({tagCommit: null});
  assert.throws(() => publishImage(options(files, {requireExistingTag: true}), dependencies), /does not exist/);
});

test("rejects localOnly and dirty frontend provenance before touching the registry", () => {
  for (const change of [
    (value) => { value.ui.localOnly = true; },
    (value) => { value.ui.dirty = true; },
  ]) {
    const files = workspace();
    const value = manifest();
    change(value);
    fs.writeFileSync(files.manifestPath, `${JSON.stringify(value, null, 2)}\n`);
    const {calls, dependencies} = harness();
    dependencies.validateContext = () => value;
    assert.throws(() => publishImage(options(files), dependencies), /Refusing to publish/);
    assert.equal(calls.length, 0);
  }
});

test("rejects a dirty or mismatched UI pin before touching the registry", () => {
  for (const pin of [
    {
      repository: "https://github.com/your-user/passbolt_styleguide.git",
      commit: UI_COMMIT,
      version: "5.16.0",
      tarballSha256: TARBALL_SHA256,
      sourceDirty: true,
    },
    {
      repository: "https://github.com/your-user/passbolt_styleguide.git",
      commit: OTHER_COMMIT,
      version: "5.16.0",
      tarballSha256: TARBALL_SHA256,
      sourceDirty: false,
    },
  ]) {
    const files = workspace();
    const {calls, dependencies} = harness({pin});
    assert.throws(() => publishImage(options(files), dependencies), /UI pin|dirty UI pin/);
    assert.equal(calls.length, 0);
  }
});

test("rejects a local image whose UI labels do not match the build", () => {
  const files = workspace();
  const localImage = image();
  localImage.Config.Labels["com.passbolt.fork.ui.commit"] = OTHER_COMMIT;
  const {calls, dependencies} = harness({localImage});
  assert.throws(() => publishImage(options(files), dependencies), /UI commit label/);
  assert.equal(calls.filter((call) => ["tag", "push", "pull"].includes(call[0])).length, 0);
});

test("a push failure leaves no receipt and does not verify a pull", () => {
  const files = workspace();
  fs.mkdirSync(files.out, {recursive: true});
  fs.writeFileSync(containerImagePath(files.out), "stale receipt\n");
  const {verifyCalls, dependencies} = harness({failOn: {push: "push denied"}});
  assert.throws(() => publishImage(options(files), dependencies), /push denied/);
  assert.equal(fs.existsSync(containerImagePath(files.out)), false);
  assert.deepEqual(verifyCalls, []);
});

test("different digests for the release and commit tags fail without a receipt", () => {
  const files = workspace();
  const {verifyCalls, dependencies} = harness({secondDigest: OTHER_DIGEST});
  assert.throws(() => publishImage(options(files), dependencies), /different digests/);
  assert.equal(fs.existsSync(containerImagePath(files.out)), false);
  assert.deepEqual(verifyCalls, []);
});

test("a digest missing from RepoDigests fails without a receipt", () => {
  const files = workspace();
  const {dependencies} = harness({repoDigests: []});
  assert.throws(() => publishImage(options(files), dependencies), /does not resolve to the registry-confirmed digest/);
  assert.equal(fs.existsSync(containerImagePath(files.out)), false);
});

test("a pull failure or pulled image mismatch leaves no receipt", () => {
  const pullFailure = workspace();
  const failed = harness({failOn: {pull: "pull denied"}});
  assert.throws(() => publishImage(options(pullFailure), failed.dependencies), /pull denied/);
  assert.equal(fs.existsSync(containerImagePath(pullFailure.out)), false);

  const mismatch = workspace();
  const pulledImage = image({Id: `sha256:${"7".repeat(64)}`, RepoDigests: [`${REPOSITORY}@${DIGEST}`]});
  const changed = harness({pulledImage});
  assert.throws(() => publishImage(options(mismatch), changed.dependencies), /image ID does not match/);
  assert.equal(fs.existsSync(containerImagePath(mismatch.out)), false);
  assert.deepEqual(changed.verifyCalls, []);
});

test("receipt validation rejects mismatched or unexpected build metadata", () => {
  const files = workspace();
  const {receipt} = publishImage(options(files), harness().dependencies);
  const expected = {
    extensionCommit: SOURCE_COMMIT,
    ui: {version: "5.16.0", commit: UI_COMMIT, tarballSha256: TARBALL_SHA256},
    manifestSha256: receipt.manifestSha256,
    baseImage: base,
  };
  assert.doesNotThrow(() => assertContainerImageReceipt(receipt, expected));

  const changes = [
    [(value) => { value.ui.commit = OTHER_COMMIT; }, /UI provenance/],
    [(value) => {
      value.extensionCommit = OTHER_COMMIT;
      value.tags = [`${REPOSITORY}:${RELEASE_TAG}`, `${REPOSITORY}:${OTHER_COMMIT}`];
    }, /extension commit/],
    [(value) => { value.manifestSha256 = "0".repeat(64); }, /manifest hash/],
    [(value) => { value.digestRef = `${REPOSITORY}@${OTHER_DIGEST}`; }, /digest reference/],
    [(value) => { value.tags = [`${REPOSITORY}:latest`]; }, /tags must be exactly/],
    [(value) => { value.token = "not-a-real-token"; }, /unexpected fields/],
  ];
  for (const [change, pattern] of changes) {
    const value = structuredClone(receipt);
    change(value);
    assert.throws(() => assertContainerImageReceipt(value, expected), pattern);
  }
  assert.equal(readContainerImageReceipt(path.join(files.directory, "empty")), null);
  assert.equal(CONTAINER_IMAGE_RECEIPT, "CONTAINER-IMAGE.json");
});

test("release creation and retries display the generated image pull notes", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/fork-build-release.yml"), "utf8");
  const lines = workflow.slice(workflow.indexOf("      - name: Publish release\n")).split("\n");
  const start = lines.indexOf("        run: |");
  assert.ok(start >= 0);
  const script = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  for (const exists of ["0", "1"]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-test-"));
    try {
      const bin = path.join(directory, "bin");
      const release = path.join(directory, "dist/release");
      const rendered = path.join(directory, "rendered-notes.txt");
      fs.mkdirSync(bin);
      fs.mkdirSync(release, {recursive: true});
      const notes = `docker pull ${REPOSITORY}@${DIGEST}\n`;
      fs.writeFileSync(path.join(release, "RELEASE_NOTES.md"), notes);
      fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
set -eu
if [ "$1 $2" = "release view" ]; then [ "$GH_TEST_EXISTS" = 1 ]; exit; fi
if [ "$1 $2" = "release edit" ] || [ "$1 $2" = "release create" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--notes-file" ]; then cp "$2" "$GH_TEST_RENDERED"; exit; fi
    shift
  done
fi
`, {mode: 0o700});
      const result = spawnSync("bash", ["-c", script.join("\n")], {
        cwd: directory,
        encoding: "utf8",
        env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_TOKEN: "fixture-token",
          RELEASE_TAG, GITHUB_SHA: SOURCE_COMMIT, GH_TEST_EXISTS: exists, GH_TEST_RENDERED: rendered},
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(rendered), `Release notes were not updated when existing=${exists}`);
      assert.equal(fs.readFileSync(rendered, "utf8"), notes);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }
});
