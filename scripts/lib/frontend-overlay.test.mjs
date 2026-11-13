import assert from "node:assert/strict";
import test from "node:test";
import {assertBaseImage, base} from "./frontend-overlay.mjs";

const inspected = () => ({
  Id: base.imageId,
  RepoDigests: [base.reference],
  Os: "linux",
  Architecture: "amd64",
  RootFS: {Type: "layers", Layers: [...base.rootfsLayers]},
});

test("accepts the pinned base with a classic image-store ID", () => {
  assert.doesNotThrow(() => assertBaseImage(inspected()));
});

test("accepts the same pinned base with a containerd descriptor ID", () => {
  const image = inspected();
  image.Id = base.reference.split("@")[1];
  assert.doesNotThrow(() => assertBaseImage(image));
});

for (const [name, change] of [
  ["a different repository digest", (image) => { image.RepoDigests = [`passbolt/passbolt@sha256:${"0".repeat(64)}`]; }],
  ["a missing repository digest", (image) => { delete image.RepoDigests; }],
  ["a different OS", (image) => { image.Os = "windows"; }],
  ["a different architecture", (image) => { image.Architecture = "arm64"; }],
  ["a different layer type", (image) => { image.RootFS.Type = "unknown"; }],
  ["a different layer", (image) => { image.RootFS.Layers[0] = `sha256:${"0".repeat(64)}`; }],
  ["a missing layer", (image) => { image.RootFS.Layers.pop(); }],
  ["an extra layer", (image) => { image.RootFS.Layers.push(`sha256:${"0".repeat(64)}`); }],
  ["reordered layers", (image) => { image.RootFS.Layers.reverse(); }],
  ["missing layer metadata", (image) => { delete image.RootFS; }],
]) {
  test(`rejects ${name} even with the expected classic ID`, () => {
    const image = inspected();
    change(image);
    assert.throws(() => assertBaseImage(image), /Pinned base image/);
  });
}
