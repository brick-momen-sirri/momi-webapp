import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { projectFolderName } from "./projectFolderName.js";
import { assertNoEmbeddedMedia } from "./storageService.js";
import type { Project } from "./types.js";

export type SqliteProjectStore = {
  countProjects(): number;
  loadProjects(): Project[];
  loadProjectById(id: string): Project | undefined;
  insertProject(project: Project): void;
  insertDiscoveredProject(project: Project): Project;
  applyToProject(id: string, mutate: (project: Project) => Project | void): Project | undefined;
  deleteProject(id: string): boolean;
  migrateFromJsonIfNeeded(projects: Project[]): boolean;
  close(): void;
};

type ProjectRow = { data: string };

export function openSqliteProjectStore(dbPath: string): SqliteProjectStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_projects (
      id TEXT PRIMARY KEY,
      folder_path_norm TEXT NOT NULL UNIQUE,
      folder_name_norm TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_projects_updated ON app_projects(updated_at);

    CREATE TABLE IF NOT EXISTS project_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const countProjects = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM app_projects");
  const selectProjects = db.prepare<[], ProjectRow>(
    "SELECT data FROM app_projects ORDER BY created_at DESC, id ASC",
  );
  const selectProjectById = db.prepare<[string], ProjectRow>("SELECT data FROM app_projects WHERE id = ?");
  const selectProjectByIdentity = db.prepare<ProjectParams, ProjectRow>(`
    SELECT data FROM app_projects
    WHERE id = @id
       OR folder_path_norm = @folder_path_norm
       OR folder_name_norm = @folder_name_norm
    LIMIT 1
  `);
  const insertProject = db.prepare(`
    INSERT INTO app_projects (id, folder_path_norm, folder_name_norm, created_at, updated_at, data)
    VALUES (@id, @folder_path_norm, @folder_name_norm, @created_at, @updated_at, @data)
  `);
  const updateProject = db.prepare(`
    UPDATE app_projects
    SET folder_path_norm = @folder_path_norm,
        folder_name_norm = @folder_name_norm,
        created_at = @created_at,
        updated_at = @updated_at,
        data = @data
    WHERE id = @id
  `);
  const deleteProject = db.prepare<[string]>("DELETE FROM app_projects WHERE id = ?");
  const migrationComplete = db.prepare<[], { value: string }>(
    "SELECT value FROM project_meta WHERE key = 'json_migration_complete'",
  );
  const markMigrationComplete = db.prepare(`
    INSERT INTO project_meta (key, value) VALUES ('json_migration_complete', @completed_at)
    ON CONFLICT(key) DO NOTHING
  `);

  const insertDiscoveredProjectTx = db.transaction((project: Project) => {
    const normalized = projectForPersistence(project);
    const params = projectParams(normalized);
    const row = selectProjectByIdentity.get(params);
    if (row) return JSON.parse(row.data) as Project;
    insertProject.run(params);
    return normalized;
  });

  const applyToProjectTx = db.transaction((id: string, mutate: (project: Project) => Project | void) => {
    const row = selectProjectById.get(id);
    if (!row) return undefined;
    const current = JSON.parse(row.data) as Project;
    const next = projectForPersistence((mutate(current) ?? current) as Project);
    assertNoEmbeddedMedia(next, `project ${id}`);
    updateProject.run(projectParams(next));
    return next;
  });

  const migrateFromJsonTx = db.transaction((projects: Project[]) => {
    if (migrationComplete.get()) return false;
    if ((countProjects.get()?.n ?? 0) === 0) {
      for (const project of projects) {
        const normalized = projectForPersistence(project);
        assertNoEmbeddedMedia(normalized, `project ${normalized.id}`);
        insertProject.run(projectParams(normalized));
      }
    }
    markMigrationComplete.run({ completed_at: new Date().toISOString() });
    return true;
  });

  return {
    countProjects() {
      return countProjects.get()?.n ?? 0;
    },
    loadProjects() {
      return selectProjects.all().map((row) => JSON.parse(row.data) as Project);
    },
    loadProjectById(id: string) {
      const row = selectProjectById.get(id);
      return row ? JSON.parse(row.data) as Project : undefined;
    },
    insertProject(project: Project) {
      const normalized = projectForPersistence(project);
      assertNoEmbeddedMedia(normalized, `project ${normalized.id}`);
      insertProject.run(projectParams(normalized));
    },
    insertDiscoveredProject(project: Project) {
      assertNoEmbeddedMedia(project, `project ${project.id}`);
      return insertDiscoveredProjectTx.immediate(project);
    },
    applyToProject(id, mutate) {
      return applyToProjectTx.immediate(id, mutate);
    },
    deleteProject(id: string) {
      return deleteProject.run(id).changes === 1;
    },
    migrateFromJsonIfNeeded(projects: Project[]) {
      return migrateFromJsonTx.immediate(projects);
    },
    close() {
      db.close();
    },
  };
}

type ProjectParams = {
  id: string;
  folder_path_norm: string;
  folder_name_norm: string;
  created_at: string;
  updated_at: string;
  data: string;
};

function projectParams(project: Project): ProjectParams {
  return {
    id: project.id,
    folder_path_norm: normalizeProjectPath(project.folderPath),
    folder_name_norm: projectFolderName(project.folderName || project.folderPath).trim().toLowerCase(),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    data: JSON.stringify(project),
  };
}

function normalizeProjectPath(folderPath: string) {
  const normalized = folderPath.trim().replaceAll("\\", "/").replace(/\/+$/g, "");
  const absolute = path.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)
    ? normalized
    : path.resolve(normalized).replaceAll("\\", "/");
  return absolute.toLowerCase();
}

function projectForPersistence(project: Project): Project {
  const normalized = { ...project, jobCount: 0 };
  delete normalized.creditsUsed;
  delete normalized.monthCreditsUsed;
  return normalized;
}
