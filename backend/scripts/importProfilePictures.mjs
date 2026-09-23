import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "..");
const dataRoot = path.join(backendRoot, "data");
const outputRoot = path.join(dataRoot, "profile-pictures");
const sqlitePath = path.join(dataRoot, "app-state.sqlite");
const usersJsonPath = path.join(dataRoot, "users.json");
const matchesPath = path.join(backendRoot, "config", "profile-picture-matches.json");
const renditionSizes = [64, 128, 256, 512];
const overwriteExisting = process.argv.includes("--overwrite");
const sourceDirectory = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

if (!sourceDirectory) {
  console.error("Usage: pnpm run profiles:import -- <portrait-directory> [--overwrite]");
  process.exit(1);
}

const resolvedSourceDirectory = path.resolve(sourceDirectory);
const now = new Date().toISOString();
const timestamp = now.replace(/[:.]/g, "-");
const matchConfig = JSON.parse(await fs.readFile(matchesPath, "utf8"));
const sourceFiles = (await fs.readdir(resolvedSourceDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (!sourceFiles.length) {
  throw new Error(`No PNG portraits found in ${resolvedSourceDirectory}`);
}

const missingConfiguredFiles = Object.keys(matchConfig).filter((fileName) => !sourceFiles.includes(fileName));
if (missingConfiguredFiles.length) {
  throw new Error(`Configured portrait files are missing: ${missingConfiguredFiles.join(", ")}`);
}

await fs.mkdir(outputRoot, { recursive: true });
const imported = await mapWithConcurrency(sourceFiles, 3, importPortrait);
const portraitsByFile = new Map(imported.map((portrait) => [portrait.sourceFile, portrait]));
const assignments = [];

for (const [sourceFile, userIdentifiers] of Object.entries(matchConfig)) {
  const portrait = portraitsByFile.get(sourceFile);
  for (const userIdentifier of userIdentifiers) {
    assignments.push({
      portraitId: portrait.id,
      sourceFile,
      userIdentifier,
      profileImageUrl: `/api/profile-pictures/${portrait.id}/avatar-256.webp`,
    });
  }
}

const sqliteResult = await updateSqliteUsers(assignments);
const jsonResult = await updateJsonUsers(assignments);
const usersByIdentifier = new Map([...sqliteResult.resolvedUsers, ...jsonResult.resolvedUsers]);

for (const portrait of imported) {
  portrait.assignedUsers = (matchConfig[portrait.sourceFile] ?? []).map((identifier) => {
    const user = usersByIdentifier.get(identifier);
    return user ? { id: user.id, name: user.displayName ?? user.name, identifier } : { identifier };
  });
}

const manifest = {
  version: 1,
  importedAt: now,
  sourceDirectory: resolvedSourceDirectory,
  aspectRatio: "1:1",
  renditions: renditionSizes.map((size) => ({ file: `avatar-${size}.webp`, width: size, height: size })),
  portraits: imported,
};
const manifestPath = path.join(outputRoot, "manifest.json");
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const unmatched = imported.filter((portrait) => portrait.assignedUsers.length === 0).map((portrait) => portrait.sourceFile);
console.log(
  JSON.stringify(
    {
      importedPortraits: imported.length,
      assignedPortraits: imported.length - unmatched.length,
      unmatchedPortraits: unmatched.length,
      updatedSqliteUsers: sqliteResult.updated,
      updatedJsonUsers: jsonResult.updated,
      skippedExistingProfiles: [...new Set([...sqliteResult.skipped, ...jsonResult.skipped])],
      missingLegacyJsonUsers: jsonResult.missing,
      manifestPath,
      unmatched,
    },
    null,
    2,
  ),
);

async function importPortrait(sourceFile) {
  const sourcePath = path.join(resolvedSourceDirectory, sourceFile);
  const sourceBytes = await fs.readFile(sourcePath);
  const contentHash = createHash("sha256").update(sourceBytes).digest("hex");
  const baseName = sourceFile.replace(/\s+-\s+1980s yearbook\.png$/i, "");
  const id = `${slugify(baseName)}-${contentHash.slice(0, 10)}`;
  const portraitDirectory = path.join(outputRoot, id);
  const metadata = await sharp(sourceBytes).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read dimensions for ${sourceFile}`);
  }

  await fs.mkdir(portraitDirectory, { recursive: true });
  await fs.copyFile(sourcePath, path.join(portraitDirectory, "original.png"));
  await Promise.all(
    renditionSizes.map((size) =>
      sharp(sourceBytes)
        .resize(size, size, { fit: "cover", position: "centre" })
        .webp({ quality: 82, effort: 5, smartSubsample: true })
        .toFile(path.join(portraitDirectory, `avatar-${size}.webp`)),
    ),
  );

  const files = {};
  for (const fileName of ["original.png", ...renditionSizes.map((size) => `avatar-${size}.webp`)]) {
    const stat = await fs.stat(path.join(portraitDirectory, fileName));
    files[fileName] = stat.size;
  }

  return {
    id,
    sourceFile,
    contentHash,
    width: metadata.width,
    height: metadata.height,
    files,
    assignedUsers: [],
  };
}

async function updateSqliteUsers(pendingAssignments) {
  try {
    await fs.access(sqlitePath);
  } catch {
    return { updated: 0, skipped: [], missing: [], resolvedUsers: new Map() };
  }

  const db = new Database(sqlitePath);
  const backupDirectory = path.join(dataRoot, "backups");
  await fs.mkdir(backupDirectory, { recursive: true });
  await db.backup(path.join(backupDirectory, `app-state-before-profile-pictures-${timestamp}.sqlite`));

  try {
    const users = db
      .prepare("SELECT id, data FROM auth_users")
      .all()
      .map((row) => JSON.parse(row.data));
    const { resolved, missing } = resolveAssignments(pendingAssignments, users);
    if (missing.length) throw new Error(`Could not match configured users in SQLite: ${missing.join(", ")}`);

    const update = db.prepare("UPDATE auth_users SET updated_at = ?, data = ? WHERE id = ?");
    const skipped = [];
    let updated = 0;
    db.transaction(() => {
      for (const item of resolved) {
        if (item.user.profileImageUrl && !overwriteExisting) {
          skipped.push(item.user.id);
          continue;
        }
        item.user.profileImageUrl = item.assignment.profileImageUrl;
        item.user.updatedAt = now;
        update.run(now, JSON.stringify(item.user), item.user.id);
        updated += 1;
      }
    })();

    return {
      updated,
      skipped,
      missing: [],
      resolvedUsers: new Map(resolved.map((item) => [item.assignment.userIdentifier, item.user])),
    };
  } finally {
    db.close();
  }
}

async function updateJsonUsers(pendingAssignments) {
  try {
    await fs.access(usersJsonPath);
  } catch {
    return { updated: 0, skipped: [], missing: [], resolvedUsers: new Map() };
  }

  const users = JSON.parse(await fs.readFile(usersJsonPath, "utf8"));
  const { resolved, missing } = resolveAssignments(pendingAssignments, users);

  const backupDirectory = path.join(dataRoot, "backups");
  await fs.mkdir(backupDirectory, { recursive: true });
  await fs.copyFile(usersJsonPath, path.join(backupDirectory, `users-before-profile-pictures-${timestamp}.json`));

  const skipped = [];
  let updated = 0;
  for (const item of resolved) {
    if (item.user.profileImageUrl && !overwriteExisting) {
      skipped.push(item.user.id);
      continue;
    }
    item.user.profileImageUrl = item.assignment.profileImageUrl;
    item.user.updatedAt = now;
    updated += 1;
  }

  const temporaryPath = `${usersJsonPath}.${process.pid}.profile-pictures.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(users, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, usersJsonPath);
  return {
    updated,
    skipped,
    missing,
    resolvedUsers: new Map(resolved.map((item) => [item.assignment.userIdentifier, item.user])),
  };
}

function resolveAssignments(pendingAssignments, users) {
  const indexes = {
    id: indexUsers(users, (user) => user.id),
    name: indexUsers(users, (user) => user.displayName ?? user.name),
    username: indexUsers(users, (user) => user.username),
  };
  const missing = [];
  const resolved = [];

  for (const assignment of pendingAssignments) {
    const separator = assignment.userIdentifier.indexOf(":");
    const kind = assignment.userIdentifier.slice(0, separator);
    const value = assignment.userIdentifier.slice(separator + 1);
    const user = indexes[kind]?.get(normalize(value));
    if (!user) missing.push(assignment.userIdentifier);
    else resolved.push({ assignment, user });
  }

  return { resolved, missing: [...new Set(missing)] };
}

function indexUsers(users, select) {
  const index = new Map();
  for (const user of users) {
    const value = select(user);
    if (typeof value === "string" && value.trim()) index.set(normalize(value), user);
  }
  return index;
}

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function slugify(value) {
  return (
    normalize(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "portrait"
  );
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
