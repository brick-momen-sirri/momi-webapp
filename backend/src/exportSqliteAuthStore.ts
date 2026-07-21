import Database from "better-sqlite3";
import { appStateSqlitePath, projectsStorePath, sessionsStorePath, usersStorePath } from "./config.js";
import { writeJsonFile } from "./storageService.js";
import type { Project, SessionRecord, StoredUser } from "./types.js";

type ExportOptions = {
  dbPath: string;
  usersPath: string;
  sessionsPath: string;
  projectsPath?: string;
  allowEmptyUsers?: boolean;
  allowEmptyProjects?: boolean;
};

export async function exportSqliteAuthStoreToJson(options: ExportOptions) {
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const users = db.prepare("SELECT data FROM auth_users ORDER BY updated_at DESC, id ASC")
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as StoredUser);
    const sessions = db.prepare(`
      SELECT id, user_id, token_hash, created_at, expires_at, last_used_at
      FROM auth_sessions
      ORDER BY created_at DESC
    `).all().map((row) => toSession(row as SessionRow));
    const projects = options.projectsPath
      ? db.prepare("SELECT data FROM app_projects ORDER BY created_at DESC, id ASC")
        .all()
        .map((row) => JSON.parse((row as { data: string }).data) as Project)
      : undefined;

    if (!users.length && !options.allowEmptyUsers) {
      throw new Error("Refusing to export an app-state database with no users. Pass allowEmptyUsers only for deliberate recovery.");
    }
    if (projects && !projects.length && !options.allowEmptyProjects) {
      throw new Error("Refusing to export an app-state database with no projects. Pass allowEmptyProjects only for deliberate recovery.");
    }
    await writeJsonFile(options.usersPath, users);
    await writeJsonFile(options.sessionsPath, sessions);
    if (projects && options.projectsPath) {
      await writeJsonFile(options.projectsPath, projects);
      return { users: users.length, sessions: sessions.length, projects: projects.length };
    }
    return { users: users.length, sessions: sessions.length };
  } finally {
    db.close();
  }
}

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
};

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  exportSqliteAuthStoreToJson({
    dbPath: appStateSqlitePath,
    usersPath: usersStorePath,
    sessionsPath: sessionsStorePath,
    projectsPath: projectsStorePath,
    allowEmptyUsers: ["1", "true", "yes"].includes((process.env.APP_STATE_EXPORT_ALLOW_EMPTY ?? "").toLowerCase()),
    allowEmptyProjects: ["1", "true", "yes"].includes((process.env.APP_STATE_EXPORT_ALLOW_EMPTY ?? "").toLowerCase()),
  }).then((result) => {
    const projectSummary = "projects" in result ? ` and ${result.projects} projects` : "";
    console.log(`Exported ${result.users} users, ${result.sessions} sessions${projectSummary} from app-state SQLite.`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
