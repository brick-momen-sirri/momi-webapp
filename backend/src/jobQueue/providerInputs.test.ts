// Characterization tests for the media path allowlist.
//
// localMediaFilePathFromUrl decides whether a job's stored media URL is allowed to
// be read off this host's disk and shipped to a generation provider. It is the only
// thing standing between a crafted `/api/media?path=` value and an arbitrary file
// read from the dispatcher process, so it is pinned here rather than left to the
// integration tests that happen to exercise it indirectly.
//
// These tests pin the separator-aware behavior at the provider boundary so this
// disk-read guard cannot regress independently from the HTTP media route.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { brickProjectsRoot, comfyRoot, localProjectsRoot, uploadedMediaRoot } from "../config.js";
import { localMediaFilePathFromUrl } from "./providerInputs.js";

function mediaUrl(filePath: string) {
  return `/api/media?path=${encodeURIComponent(filePath)}`;
}

test("accepts media under each allowed root", () => {
  const allowedRoots = [
    path.join(uploadedMediaRoot, "prj_1", "usr_1", "input.png"),
    path.join(brickProjectsRoot, "1234_Client_Project", "images", "shot.png"),
    path.join(localProjectsRoot, "PLAY_Playground", "videos", "clip.mp4"),
    path.join(comfyRoot, "output", "render.png"),
    path.join(comfyRoot, "input", "reference.png"),
  ];

  for (const filePath of allowedRoots) {
    assert.equal(localMediaFilePathFromUrl(mediaUrl(filePath)), path.resolve(filePath), `should allow ${filePath}`);
  }
});

test("refuses a path outside every allowed root", () => {
  assert.equal(localMediaFilePathFromUrl(mediaUrl("C:\\Windows\\win.ini")), undefined);
  assert.equal(localMediaFilePathFromUrl(mediaUrl("C:\\Users\\someone\\.ssh\\id_rsa")), undefined);
});

test("refuses traversal that climbs out of an allowed root", () => {
  // Resolves outside the root even though the string starts inside it -- the guard
  // must normalise before comparing, not pattern-match the raw value.
  const escaped = path.join(uploadedMediaRoot, "..", "..", "..", "..", "Windows", "win.ini");
  assert.equal(localMediaFilePathFromUrl(mediaUrl(escaped)), undefined);
});

test("refuses URLs that are not the media route", () => {
  const inside = path.join(uploadedMediaRoot, "prj_1", "input.png");
  assert.equal(localMediaFilePathFromUrl(`/api/jobs?path=${encodeURIComponent(inside)}`), undefined);
  assert.equal(localMediaFilePathFromUrl(`/api/media/extra?path=${encodeURIComponent(inside)}`), undefined);
});

test("refuses media URLs with no usable path parameter", () => {
  assert.equal(localMediaFilePathFromUrl("/api/media"), undefined);
  assert.equal(localMediaFilePathFromUrl("/api/media?path="), undefined);
  assert.equal(localMediaFilePathFromUrl(""), undefined);
  assert.equal(localMediaFilePathFromUrl("not a url at all"), undefined);
});

test("treats an absolute backend media URL the same as a relative one", () => {
  const inside = path.join(uploadedMediaRoot, "prj_1", "input.png");
  assert.equal(localMediaFilePathFromUrl(`http://127.0.0.1:3333${mediaUrl(inside)}`), path.resolve(inside));
});

test("refuses sibling directories that merely share an allowed root prefix", () => {
  // uploadedMediaRoot is intentionally nested inside localProjectsRoot, so its
  // siblings are separately covered by that broader root. The Comfy input root
  // has no broader allowlist entry and isolates the prefix-boundary guarantee.
  const comfyInputRoot = path.join(comfyRoot, "input");
  const siblingOfRoot = `${comfyInputRoot}_evil${path.sep}stolen.png`;
  assert.equal(localMediaFilePathFromUrl(mediaUrl(siblingOfRoot)), undefined);
  assert.equal(localMediaFilePathFromUrl(mediaUrl(`${comfyInputRoot}2${path.sep}stolen.png`)), undefined);
  assert.equal(localMediaFilePathFromUrl(mediaUrl(`${comfyInputRoot}-backup${path.sep}stolen.png`)), undefined);
});

test("refuses URL-decoded and double-encoded traversal values", () => {
  const escaped = path.resolve(uploadedMediaRoot, "..", "outside", "secret.png");
  const onceEncodedTraversal = `/api/media?path=${encodeURIComponent(uploadedMediaRoot)}%2F..%2Foutside%2Fsecret.png`;
  const doubleEncodedPath = `/api/media?path=${encodeURIComponent(encodeURIComponent(escaped))}`;

  assert.equal(localMediaFilePathFromUrl(onceEncodedTraversal), undefined);
  assert.equal(localMediaFilePathFromUrl(doubleEncodedPath), undefined);
});
