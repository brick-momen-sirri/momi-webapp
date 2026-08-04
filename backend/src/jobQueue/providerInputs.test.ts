// Characterization tests for the media path allowlist.
//
// localMediaFilePathFromUrl decides whether a job's stored media URL is allowed to
// be read off this host's disk and shipped to a generation provider. It is the only
// thing standing between a crafted `/api/media?path=` value and an arbitrary file
// read from the dispatcher process, so it is pinned here rather than left to the
// integration tests that happen to exercise it indirectly.
//
// These tests assert current behavior on purpose -- including one sharp edge noted
// at the bottom -- so that a future change to the guard has to be deliberate.
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

// Known sharp edge, pinned deliberately rather than fixed here.
//
// The allowlist compares with startsWith() on the resolved, lowercased path and
// does NOT append a separator, so a *sibling* directory whose name merely begins
// with an allowed root is also accepted. Reaching it still requires the attacker to
// influence ?path= AND for that file to exist on this host, so this is hardening
// rather than an open hole -- but the fix (compare against `root + path.sep`, plus
// an equality check for the root itself) is a security behavior change and should
// land on its own, with the LAN exposure of /api/media reviewed at the same time.
test("KNOWN GAP: a sibling directory sharing an allowed root's prefix is accepted", () => {
  const siblingOfRoot = `${uploadedMediaRoot}_evil${path.sep}stolen.png`;
  assert.equal(
    localMediaFilePathFromUrl(mediaUrl(siblingOfRoot)),
    path.resolve(siblingOfRoot),
    "documents today's behavior; tighten with a separator-aware comparison",
  );
});
