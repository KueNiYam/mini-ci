import { appendFileSync, mkdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  createId,
  createRunRef,
  nowIso,
  type Job,
  type JobStepResult,
  type Project,
} from "./domains/ci/models.ts";
import {
  ensureMiniCiHome,
  findJobById,
  findLatestJob,
  findLatestJobForProject,
  findProjectById,
  findProjectByName,
  findProjects,
  findRecentJobs,
  findRecentJobsForProject,
  findTriggerTokenHash,
  initializeDatabase,
  insertJob,
  resolvePaths,
  saveProject,
  saveTriggerTokenHash,
  updateJobStatus,
} from "./adapters/database/sqlite.ts";
import { runShellCommand } from "./adapters/process/shell.ts";

/** init 명령이 사용자에게 보여줄 생성 경로 결과입니다. */
export type InitResult = Readonly<{
  home: string;
  dbPath: string;
  logsDir: string;
}>;

/** project add 명령이 도메인 설정 생성에 넘기는 검증된 입력입니다. */
export type AddProjectInput = Readonly<{
  name: string;
  projectPath: string;
  commands: readonly string[];
}>;

/** 환경변수와 기본값을 기준으로 Mini CI 홈 경로를 결정합니다. */
export function resolveMiniCiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINI_CI_HOME ? resolve(env.MINI_CI_HOME) : join(homedir(), ".mini-ci");
}

/** Mini CI 홈, DB, 로그 디렉터리를 초기화합니다. */
export function initMiniCi(home: string): InitResult {
  const paths = ensureMiniCiHome(home);
  initializeDatabase(home);

  return {
    home: paths.home,
    dbPath: paths.dbPath,
    logsDir: paths.logsDir,
  };
}

/** 기존 directory를 프로젝트에 연결하고 CI 실행 설정을 저장합니다. */
export function addProject(home: string, input: AddProjectInput): Project {
  initMiniCi(home);

  if (!/^[A-Za-z0-9._-]+$/.test(input.name)) {
    throw new Error("프로젝트 이름은 영문, 숫자, '.', '_', '-'만 사용할 수 있습니다.");
  }

  const projectPath = realpathSync(resolve(input.projectPath));
  if (!statSync(projectPath).isDirectory()) {
    throw new Error(`directory가 아닙니다: ${projectPath}`);
  }

  if (input.commands.length === 0) {
    throw new Error("최소 하나 이상의 --cmd 값을 입력해야 합니다.");
  }

  const project: Project = {
    id: createId(),
    name: input.name,
    projectPath,
    commands: input.commands,
    createdAt: nowIso(),
  };

  saveProject(home, project);
  return project;
}

/** 프로젝트 이름과 ref 기준으로 CI job을 생성하고 모든 command를 실행합니다. */
export function runProjectByName(home: string, input: Readonly<{ name: string; ref?: string }>): Job {
  initializeDatabase(home);

  const project = findProjectByName(home, input.name);
  if (!project) {
    throw new Error(`프로젝트를 찾을 수 없습니다: ${input.name}`);
  }

  return createAndRunJob(home, project, input.ref ?? createRunRef());
}

/** 프로젝트와 ref 기준으로 CI job을 생성하고 모든 command를 실행합니다. */
export function createAndRunJob(home: string, project: Project, ref: string): Job {
  const paths = resolvePaths(home);
  const projectLogDir = join(paths.logsDir, project.name);
  mkdirSync(projectLogDir, { recursive: true });

  const jobId = createId();
  const job: Job = {
    id: jobId,
    projectId: project.id,
    ref,
    status: "queued",
    failedStep: null,
    exitCode: null,
    logPath: join(projectLogDir, `${jobId}.log`),
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };

  insertJob(home, job);
  appendLog(job.logPath, `Mini CI job ${job.id}\nproject: ${project.name}\nref: ${ref}\npath: ${project.projectPath}\n\n`);
  updateJobStatus(home, job.id, {
    status: "running",
    failedStep: null,
    exitCode: null,
    startedAt: nowIso(),
  });

  const result = runJobSteps(project, job.logPath);
  updateJobStatus(home, job.id, {
    status: result.status,
    failedStep: result.failedStep,
    exitCode: result.exitCode,
    finishedAt: nowIso(),
  });

  const saved = findJobById(home, job.id);
  if (!saved) {
    throw new Error(`생성한 job을 다시 조회하지 못했습니다: ${job.id}`);
  }

  return saved;
}

/** 같은 ref로 기존 job을 재실행합니다. */
export function rerunJob(home: string, jobId: string): Job {
  initializeDatabase(home);

  const job = findJobById(home, jobId);
  if (!job) {
    throw new Error(`job을 찾을 수 없습니다: ${jobId}`);
  }

  const project = findProjectById(home, job.projectId);
  if (!project) {
    throw new Error(`프로젝트를 찾을 수 없습니다: ${job.projectId}`);
  }

  return createAndRunJob(home, project, job.ref);
}

/** 대시보드 API에서 사용할 최신 job을 조회합니다. */
export function getLatestJob(home: string): ReturnType<typeof findLatestJob> {
  initializeDatabase(home);
  return findLatestJob(home);
}

/** 대시보드 API에서 사용할 프로젝트 목록을 조회합니다. */
export function getProjects(home: string): ReturnType<typeof findProjects> {
  initializeDatabase(home);
  return findProjects(home);
}

/** 대시보드 API에서 사용할 프로젝트별 최신 job을 이름 기준으로 조회합니다. */
export function getLatestJobForProjectName(home: string, name: string): ReturnType<typeof findLatestJobForProject> {
  initializeDatabase(home);
  const project = findProjectByName(home, name);
  return project ? findLatestJobForProject(home, project.id) : null;
}

/** 대시보드 API에서 사용할 최근 job 실행 이력을 조회합니다. */
export function getRecentJobs(home: string): ReturnType<typeof findRecentJobs> {
  initializeDatabase(home);
  return findRecentJobs(home);
}

/** 대시보드 API에서 사용할 프로젝트별 job 이력을 이름 기준으로 조회합니다. */
export function getRecentJobsForProjectName(
  home: string,
  name: string,
): ReturnType<typeof findRecentJobsForProject> {
  initializeDatabase(home);
  const project = findProjectByName(home, name);
  return project ? findRecentJobsForProject(home, project.id) : [];
}

/** job 상세 정보를 조회합니다. */
export function getJob(home: string, jobId: string): Job | null {
  initializeDatabase(home);
  return findJobById(home, jobId);
}

/** job 로그 파일 내용을 읽습니다. */
export function getJobLog(home: string, jobId: string): string | null {
  initializeDatabase(home);

  const job = findJobById(home, jobId);
  if (!job) {
    return null;
  }

  return readFileSync(job.logPath, "utf8");
}

/** 새 trigger token을 저장하고 생성 직후 한 번만 보여줄 원문을 반환합니다. */
export function setTriggerToken(home: string, token: string = createSecretToken()): string {
  initializeDatabase(home);
  saveTriggerTokenHash(home, hashToken(token), nowIso());
  return token;
}

/** trigger token이 설정되어 있는지 확인합니다. */
export function isTriggerTokenConfigured(home: string): boolean {
  initializeDatabase(home);
  return findTriggerTokenHash(home) !== null;
}

/** 요청 token이 저장된 trigger token과 같은지 확인합니다. */
export function verifyTriggerToken(home: string, token: string): boolean {
  initializeDatabase(home);
  const expectedHash = findTriggerTokenHash(home);
  if (!expectedHash) {
    return false;
  }

  return safeEqualHex(expectedHash, hashToken(token));
}

/** command 실행과 실패 중단 정책을 순서대로 수행합니다. */
function runJobSteps(project: Project, logPath: string): JobStepResult {
  for (const command of project.commands) {
    appendLog(logPath, `$ ${command}\n`);
    const result = runShellCommand(command, project.projectPath);
    appendLog(logPath, result.stdout);
    appendLog(logPath, result.stderr);

    if (result.exitCode !== 0) {
      appendLog(logPath, `\nfailed: ${command} (${result.exitCode})\n`);
      return { status: "failed", failedStep: command, exitCode: result.exitCode };
    }

    appendLog(logPath, "\n");
  }

  appendLog(logPath, "success\n");
  return { status: "success", failedStep: null, exitCode: 0 };
}

/** 로그 파일에 문자열을 누적합니다. */
function appendLog(path: string, text: string): void {
  appendFileSync(path, text);
}

/** trigger/admin token으로 사용할 난수 문자열을 만듭니다. */
function createSecretToken(): string {
  return randomBytes(32).toString("hex");
}

/** token 원문을 저장용 hash로 변환합니다. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 길이 차이로 인한 비교 예외를 피하면서 hex hash를 비교합니다. */
function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
