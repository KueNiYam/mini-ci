import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Job, JobStatus, Project } from "../../domains/ci/models.ts";

export type MiniCiPaths = Readonly<{
  home: string;
  dbPath: string;
  logsDir: string;
}>;

const SCHEMA_VERSION = 2;

/** sqlite3 JSON 출력의 경계 타입입니다. */
type Row = Record<string, unknown>;

/** Mini CI 홈 기준으로 필요한 파일 경로를 계산합니다. */
export function resolvePaths(home: string): MiniCiPaths {
  return {
    home,
    dbPath: join(home, "mini-ci.sqlite"),
    logsDir: join(home, "logs"),
  };
}

/** Mini CI 홈 디렉터리와 로그 디렉터리를 준비합니다. */
export function ensureMiniCiHome(home: string): MiniCiPaths {
  const paths = resolvePaths(home);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  return paths;
}

/** SQLite 스키마를 directory mode 기준으로 초기화합니다. */
export function initializeDatabase(home: string): void {
  ensureMiniCiHome(home);

  if (readUserVersion(home) !== SCHEMA_VERSION) {
    execSql(
      home,
      `
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS jobs;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS settings;
      PRAGMA user_version = ${SCHEMA_VERSION};
      `,
    );
  }

  execSql(
    home,
    `
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      project_path TEXT NOT NULL,
      commands_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      status TEXT NOT NULL,
      failed_step TEXT,
      exit_code INTEGER,
      log_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_project_id_idx ON jobs(project_id);

    PRAGMA user_version = ${SCHEMA_VERSION};
    `,
  );
}

/** 프로젝트 설정을 저장하거나 같은 이름의 프로젝트를 갱신합니다. */
export function saveProject(home: string, project: Project): void {
  execSql(
    home,
    `
    INSERT INTO projects (
      id,
      name,
      project_path,
      commands_json,
      created_at
    )
    VALUES (
      ${sqlText(project.id)},
      ${sqlText(project.name)},
      ${sqlText(project.projectPath)},
      ${sqlText(JSON.stringify(project.commands))},
      ${sqlText(project.createdAt)}
    )
    ON CONFLICT(name) DO UPDATE SET
      id = excluded.id,
      project_path = excluded.project_path,
      commands_json = excluded.commands_json,
      created_at = excluded.created_at;
    `,
  );
}

/** ID로 프로젝트 설정을 조회합니다. */
export function findProjectById(home: string, projectId: string): Project | null {
  const rows = queryRows(
    home,
    `
    SELECT
      id,
      name,
      project_path,
      commands_json,
      created_at
    FROM projects
    WHERE id = ${sqlText(projectId)}
    LIMIT 1;
    `,
  );

  return rows[0] ? rowToProject(rows[0]) : null;
}

/** 이름으로 프로젝트 설정을 조회합니다. */
export function findProjectByName(home: string, name: string): Project | null {
  const rows = queryRows(
    home,
    `
    SELECT
      id,
      name,
      project_path,
      commands_json,
      created_at
    FROM projects
    WHERE name = ${sqlText(name)}
    LIMIT 1;
    `,
  );

  return rows[0] ? rowToProject(rows[0]) : null;
}

/** 최신 프로젝트 설정을 조회합니다. */
export function findLatestProject(home: string): Project | null {
  const rows = queryRows(
    home,
    `
    SELECT
      id,
      name,
      project_path,
      commands_json,
      created_at
    FROM projects
    ORDER BY created_at DESC
    LIMIT 1;
    `,
  );

  return rows[0] ? rowToProject(rows[0]) : null;
}

/** 모든 프로젝트 설정을 이름순으로 조회합니다. */
export function findProjects(home: string): readonly Project[] {
  const rows = queryRows(
    home,
    `
    SELECT
      id,
      name,
      project_path,
      commands_json,
      created_at
    FROM projects
    ORDER BY name ASC;
    `,
  );

  return rows.map(rowToProject);
}

/** trigger token hash를 저장합니다. */
export function saveTriggerTokenHash(home: string, tokenHash: string, updatedAt: string): void {
  execSql(
    home,
    `
    INSERT INTO settings (key, value, updated_at)
    VALUES ('trigger_token_hash', ${sqlText(tokenHash)}, ${sqlText(updatedAt)})
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at;
    `,
  );
}

/** 저장된 trigger token hash를 조회합니다. */
export function findTriggerTokenHash(home: string): string | null {
  const rows = queryRows(
    home,
    `
    SELECT value
    FROM settings
    WHERE key = 'trigger_token_hash'
    LIMIT 1;
    `,
  );

  return rows[0] ? String(rows[0].value) : null;
}

/** 새 job을 저장합니다. */
export function insertJob(home: string, job: Job): void {
  execSql(
    home,
    `
    INSERT INTO jobs (
      id,
      project_id,
      ref,
      status,
      failed_step,
      exit_code,
      log_path,
      created_at,
      started_at,
      finished_at
    )
    VALUES (
      ${sqlText(job.id)},
      ${sqlText(job.projectId)},
      ${sqlText(job.ref)},
      ${sqlText(job.status)},
      ${sqlNullableText(job.failedStep)},
      ${sqlNullableNumber(job.exitCode)},
      ${sqlText(job.logPath)},
      ${sqlText(job.createdAt)},
      ${sqlNullableText(job.startedAt)},
      ${sqlNullableText(job.finishedAt)}
    );
    `,
  );
}

/** job 상태와 실행 결과를 갱신합니다. */
export function updateJobStatus(
  home: string,
  jobId: string,
  update: Readonly<{
    status: JobStatus;
    failedStep: string | null;
    exitCode: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }>,
): void {
  const startedAtSql = update.startedAt === undefined ? "" : `started_at = ${sqlNullableText(update.startedAt)},`;
  const finishedAtSql = update.finishedAt === undefined ? "" : `finished_at = ${sqlNullableText(update.finishedAt)},`;

  execSql(
    home,
    `
    UPDATE jobs
    SET
      status = ${sqlText(update.status)},
      failed_step = ${sqlNullableText(update.failedStep)},
      exit_code = ${sqlNullableNumber(update.exitCode)},
      ${startedAtSql}
      ${finishedAtSql}
      id = id
    WHERE id = ${sqlText(jobId)};
    `,
  );
}

/** 최신 job과 프로젝트 정보를 함께 조회합니다. */
export function findLatestJob(home: string): (Job & Readonly<{ projectName: string }>) | null {
  const rows = queryRows(home, latestJobSql(""));
  return rows[0] ? rowToJobWithProject(rows[0]) : null;
}

/** 특정 프로젝트의 최신 job을 조회합니다. */
export function findLatestJobForProject(
  home: string,
  projectId: string,
): (Job & Readonly<{ projectName: string }>) | null {
  const rows = queryRows(home, latestJobSql(`WHERE jobs.project_id = ${sqlText(projectId)}`));
  return rows[0] ? rowToJobWithProject(rows[0]) : null;
}

/** 최근 job 실행 이력을 최신순으로 조회합니다. */
export function findRecentJobs(home: string, limit: number = 20): readonly (Job & Readonly<{ projectName: string }>)[] {
  const rows = queryRows(home, recentJobsSql("", limit));
  return rows.map(rowToJobWithProject);
}

/** 특정 프로젝트의 최근 job 이력을 조회합니다. */
export function findRecentJobsForProject(
  home: string,
  projectId: string,
  limit: number = 20,
): readonly (Job & Readonly<{ projectName: string }>)[] {
  const rows = queryRows(home, recentJobsSql(`WHERE jobs.project_id = ${sqlText(projectId)}`, limit));
  return rows.map(rowToJobWithProject);
}

/** ID로 job을 조회합니다. */
export function findJobById(home: string, jobId: string): Job | null {
  const rows = queryRows(
    home,
    `
    SELECT
      id,
      project_id,
      ref,
      status,
      failed_step,
      exit_code,
      log_path,
      created_at,
      started_at,
      finished_at
    FROM jobs
    WHERE id = ${sqlText(jobId)}
    LIMIT 1;
    `,
  );

  return rows[0] ? rowToJob(rows[0]) : null;
}

/** SQL 문을 실행하고 결과를 반환하지 않습니다. */
function execSql(home: string, sql: string): void {
  const dbPath = resolvePaths(home).dbPath;
  const result = spawnSync("sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 실행에 실패했습니다.");
  }
}

/** 현재 DB schema version을 조회합니다. */
function readUserVersion(home: string): number {
  const dbPath = resolvePaths(home).dbPath;
  const result = spawnSync("sqlite3", [dbPath, "PRAGMA user_version;"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "SQLite schema version 조회에 실패했습니다.");
  }

  return Number(result.stdout.trim() || "0");
}

/** SQL 조회 결과를 JSON row 배열로 반환합니다. */
function queryRows(home: string, sql: string): readonly Row[] {
  const dbPath = resolvePaths(home).dbPath;
  if (!existsSync(dbPath)) {
    return [];
  }

  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 조회에 실패했습니다.");
  }

  return result.stdout.trim() ? (JSON.parse(result.stdout) as readonly Row[]) : [];
}

/** 최신 job 조회 SQL을 만듭니다. */
function latestJobSql(whereClause: string): string {
  return `
  ${baseJobSelectSql()}
  ${whereClause}
  ORDER BY jobs.created_at DESC
  LIMIT 1;
  `;
}

/** 최근 job 조회 SQL을 만듭니다. */
function recentJobsSql(whereClause: string, limit: number): string {
  return `
  ${baseJobSelectSql()}
  ${whereClause}
  ORDER BY jobs.created_at DESC
  LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))};
  `;
}

/** job과 프로젝트 이름을 함께 읽는 공통 SELECT 절입니다. */
function baseJobSelectSql(): string {
  return `
  SELECT
    jobs.id,
    jobs.project_id,
    jobs.ref,
    jobs.status,
    jobs.failed_step,
    jobs.exit_code,
    jobs.log_path,
    jobs.created_at,
    jobs.started_at,
    jobs.finished_at,
    projects.name AS project_name
  FROM jobs
  JOIN projects ON projects.id = jobs.project_id
  `;
}

/** 문자열 값을 SQL literal로 변환합니다. */
function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** nullable 문자열 값을 SQL literal로 변환합니다. */
function sqlNullableText(value: string | null): string {
  return value === null ? "NULL" : sqlText(value);
}

/** nullable 숫자 값을 SQL literal로 변환합니다. */
function sqlNullableNumber(value: number | null): string {
  return value === null ? "NULL" : String(value);
}

/** SQLite row를 프로젝트 모델로 변환합니다. */
function rowToProject(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    projectPath: String(row.project_path),
    commands: JSON.parse(String(row.commands_json)) as readonly string[],
    createdAt: String(row.created_at),
  };
}

/** SQLite row를 프로젝트 이름이 포함된 job 모델로 변환합니다. */
function rowToJobWithProject(row: Row): Job & Readonly<{ projectName: string }> {
  return { ...rowToJob(row), projectName: String(row.project_name) };
}

/** SQLite row를 job 모델로 변환합니다. */
function rowToJob(row: Row): Job {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    ref: String(row.ref),
    status: String(row.status) as JobStatus,
    failedStep: row.failed_step === null ? null : String(row.failed_step),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    logPath: String(row.log_path),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}
