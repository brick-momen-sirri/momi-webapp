import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportSqliteAuthStoreToJson } from "./exportSqliteAuthStore.js";
import { openSqliteAuthStore } from "./sqliteAuthStore.js";
import { openSqliteProjectStore } from "./sqliteProjectStore.js";
import type { Project, SessionRecord, StoredUser } from "./types.js";

test("app-state export round-trips users, sessions, and projects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-auth-export-"));
  try {
    const dbPath = path.join(dir, "app-state.sqlite");
    const usersPath = path.join(dir, "users.json");
    const sessionsPath = path.join(dir, "sessions.json");
    const projectsPath = path.join(dir, "projects.json");
    const storedUser = user();
    const storedSession = session();
    const storedProject = project();
    const store = openSqliteAuthStore(dbPath);
    store.insertUser(storedUser);
    store.insertSession(storedSession);
    store.close();
    const projectStore = openSqliteProjectStore(dbPath);
    projectStore.insertProject(storedProject);
    projectStore.close();

    const result = await exportSqliteAuthStoreToJson({ dbPath, usersPath, sessionsPath, projectsPath });
    assert.deepEqual(result, { users: 1, sessions: 1, projects: 1 });
    assert.deepEqual(JSON.parse(await fs.readFile(usersPath, "utf8")), [storedUser]);
    assert.deepEqual(JSON.parse(await fs.readFile(sessionsPath, "utf8")), [storedSession]);
    assert.deepEqual(JSON.parse(await fs.readFile(projectsPath, "utf8")), [storedProject]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("missing app-state DB fails without replacing JSON rollback files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-auth-export-missing-"));
  try {
    const usersPath = path.join(dir, "users.json");
    const sessionsPath = path.join(dir, "sessions.json");
    const projectsPath = path.join(dir, "projects.json");
    await fs.writeFile(usersPath, "users-sentinel", "utf8");
    await fs.writeFile(sessionsPath, "sessions-sentinel", "utf8");
    await fs.writeFile(projectsPath, "projects-sentinel", "utf8");

    await assert.rejects(exportSqliteAuthStoreToJson({
      dbPath: path.join(dir, "missing.sqlite"),
      usersPath,
      sessionsPath,
      projectsPath,
    }));
    assert.equal(await fs.readFile(usersPath, "utf8"), "users-sentinel");
    assert.equal(await fs.readFile(sessionsPath, "utf8"), "sessions-sentinel");
    assert.equal(await fs.readFile(projectsPath, "utf8"), "projects-sentinel");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function user(): StoredUser {
  return {
    id: "usr_1",
    email: "user@example.com",
    username: "user",
    name: "User",
    displayName: "User",
    passwordHash: "hash",
    role: "user",
    active: true,
    pinnedProjectIds: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function session(): SessionRecord {
  return {
    id: "ses_1",
    userId: "usr_1",
    tokenHash: "hash_1",
    createdAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-22T00:00:00.000Z",
    lastUsedAt: "2026-07-21T00:00:00.000Z",
  };
}

function project(): Project {
  return {
    id: "prj_1",
    name: "Project",
    shortName: "1234",
    code: "1234",
    client: "Client",
    displayName: "Client - Project",
    diskName: "1234_Client_Project",
    folderName: "1234_Client_Project",
    folderPath: "C:\\projects\\1234_Client_Project",
    ownerId: "usr_1",
    members: [{
      userId: "usr_1",
      role: "owner",
      addedAt: "2026-07-20T00:00:00.000Z",
      addedBy: "usr_1",
    }],
    groupMembers: [],
    jobCount: 0,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}
