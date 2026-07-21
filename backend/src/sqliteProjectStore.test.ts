import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteProjectStore } from "./sqliteProjectStore.js";
import type { Project, ProjectMember } from "./types.js";

async function withStores(run: (
  a: ReturnType<typeof openSqliteProjectStore>,
  b: ReturnType<typeof openSqliteProjectStore>,
) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-project-sqlite-"));
  const dbPath = path.join(dir, "app-state.sqlite");
  const a = openSqliteProjectStore(dbPath);
  const b = openSqliteProjectStore(dbPath);
  try {
    run(a, b);
  } finally {
    a.close();
    b.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("project JSON migration is atomic and runs once across connections", async () => {
  await withStores((a, b) => {
    const seed = project("prj_seed", "1000_Client_Seed", { jobCount: 42, creditsUsed: 12 });
    assert.equal(a.migrateFromJsonIfNeeded([seed]), true);
    assert.equal(b.migrateFromJsonIfNeeded([project("prj_other", "1001_Client_Other")]), false);

    const migrated = b.loadProjectById(seed.id);
    assert.equal(migrated?.jobCount, 0);
    assert.equal(migrated?.creditsUsed, undefined);
    assert.deepEqual(b.loadProjects().map((item) => item.id), [seed.id]);
  });
});

test("ACL changes are immediately visible on another connection", async () => {
  await withStores((a, b) => {
    const stored = project("prj_1", "1000_Client_Project");
    a.insertProject(stored);

    a.applyToProject(stored.id, (current) => {
      current.members.push(member("usr_viewer", "viewer"));
      current.updatedAt = "2026-07-21T01:00:00.000Z";
    });
    assert.equal(b.loadProjectById(stored.id)?.members.some((item) => item.userId === "usr_viewer"), true);

    b.applyToProject(stored.id, (current) => {
      current.members = current.members.filter((item) => item.userId !== "usr_viewer");
      current.updatedAt = "2026-07-21T02:00:00.000Z";
    });
    assert.equal(a.loadProjectById(stored.id)?.members.some((item) => item.userId === "usr_viewer"), false);
  });
});

test("row transactions preserve edits to different and identical projects", async () => {
  await withStores((a, b) => {
    const first = project("prj_1", "1000_Client_First");
    const second = project("prj_2", "1001_Client_Second");
    a.insertProject(first);
    a.insertProject(second);

    a.applyToProject(first.id, (current) => {
      current.description = "edited by A";
      current.updatedAt = "2026-07-21T01:00:00.000Z";
    });
    b.applyToProject(second.id, (current) => {
      current.description = "edited by B";
      current.updatedAt = "2026-07-21T01:00:00.000Z";
    });
    b.applyToProject(first.id, (current) => {
      current.members.push(member("usr_editor", "editor"));
      current.updatedAt = "2026-07-21T02:00:00.000Z";
    });

    assert.equal(b.loadProjectById(first.id)?.description, "edited by A");
    assert.equal(a.loadProjectById(first.id)?.members.some((item) => item.userId === "usr_editor"), true);
    assert.equal(a.loadProjectById(second.id)?.description, "edited by B");
  });
});

test("renamed paths are immediate and folder identity is unique", async () => {
  await withStores((a, b) => {
    const stored = project("prj_1", "1000_Client_Old");
    a.insertProject(stored);
    const renamedPath = path.join(path.dirname(stored.folderPath), "1000_Client_New");

    a.applyToProject(stored.id, (current) => {
      current.name = "New";
      current.folderName = "1000_Client_New";
      current.diskName = current.folderName;
      current.folderPath = renamedPath;
      current.updatedAt = "2026-07-21T01:00:00.000Z";
    });

    assert.equal(b.loadProjectById(stored.id)?.folderPath, renamedPath);
    assert.throws(
      () => b.insertProject(project("prj_collision", "1000_Client_New")),
      /UNIQUE/i,
    );
  });
});

test("filesystem discovery never replaces an existing ACL record", async () => {
  await withStores((a, b) => {
    const stored = project("prj_1", "1000_Client_Project", {
      members: [member("usr_owner", "owner"), member("usr_private", "viewer")],
    });
    a.insertProject(stored);
    const discovered = project(stored.id, "1000_Client_Project", {
      ownerId: "usr_momen",
      members: [member("usr_momen", "owner")],
    });

    const result = b.insertDiscoveredProject(discovered);
    assert.equal(result.ownerId, "usr_owner");
    assert.equal(result.members.some((item) => item.userId === "usr_private"), true);
    assert.equal(a.countProjects(), 1);
  });
});

function project(id: string, folderName: string, overrides: Partial<Project> = {}): Project {
  const createdAt = "2026-07-20T00:00:00.000Z";
  return {
    id,
    name: folderName.split("_").slice(2).join(" "),
    shortName: folderName.slice(0, 4),
    code: folderName.slice(0, 4),
    client: "Client",
    displayName: `Client - ${folderName}`,
    diskName: folderName,
    folderName,
    folderPath: path.join("C:\\projects", folderName),
    ownerId: "usr_owner",
    members: [member("usr_owner", "owner")],
    groupMembers: [],
    jobCount: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function member(userId: string, role: ProjectMember["role"]): ProjectMember {
  return {
    userId,
    role,
    addedAt: "2026-07-20T00:00:00.000Z",
    addedBy: "usr_owner",
  };
}
