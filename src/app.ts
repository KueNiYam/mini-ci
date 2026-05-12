import { appendFileSync, mkdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  createId,
  createRunDate,
  nowIso,
  type Job,
  type JobStepResult,
  type Project,
} from "./domains/ci/models.ts";
import {
  ensureMiniCiHome,
  findJobById,
  findJobByIdWithProject,
  findLatestJob,
  findLatestJobForProject,
  findProjectById,
  findProjectByName,
  findProjects,
  findRecentJobs,
  findRecentJobsForProject,
  initializeDatabase,
  insertJob,
  resolvePaths,
  saveProject,
  updateJobStatus,
} from "./adapters/database/sqlite.ts";
import { runShellCommand } from "./adapters/process/shell.ts";

/** init 명령이 사용자에게 보여줄 생성 경로 결과입니다. */
export type InitResult = Readonly<{
  home: string;
  dbPath: string;
  logsDir: string;
}>;

/** Admin API가 도메인 설정 생성에 넘기는 검증된 프로젝트 입력입니다. */
export type AddProjectInput = Readonly<{
  name: string;
  projectPaths: readonly string[];
  projectRoot?: string;
  commands: readonly string[];
}>;

/** Run API가 실행 대상 worktree와 날짜를 지정할 때 사용하는 입력입니다. */
export type RunProjectInput = Readonly<{
  name: string;
  worktreePath?: string;
  projectRoot?: string;
  runDate?: string;
}>;

/** job 저장과 로그에 남기는 실행 대상 메타데이터입니다. */
type RunMetadata = Readonly<{
  worktreePath: string;
  worktreeId: string;
  runDate: string;
}>;

/** 실제 command를 실행할 project path 목록과 저장 메타데이터입니다. */
type RunTarget = Readonly<{
  project: Project;
  metadata: RunMetadata;
}>;

/** 환경변수와 기본값을 기준으로 Mini CI 홈 경로를 결정합니다. */
export function resolveMiniCiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINI_CI_HOME ? resolve(env.MINI_CI_HOME) : join(homedir(), ".mini-ci");
}

/** project directory 입력을 해석할 기준 디렉터리를 결정합니다. */
export function resolveProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINI_CI_PROJECT_ROOT ? resolve(env.MINI_CI_PROJECT_ROOT) : join(homedir(), ".codex", "worktrees");
}

/** project root 디렉터리를 만들고 실제 경로를 반환합니다. */
export function ensureProjectRoot(projectRoot: string = resolveProjectRoot()): string {
  const resolved = resolve(projectRoot);
  mkdirSync(resolved, { recursive: true });
  return realpathSync(resolved);
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

  const projectPaths = resolveProjectPaths(input.projectRoot ?? resolveProjectRoot(), input.projectPaths);
  if (projectPaths.length === 0) {
    throw new Error("최소 하나 이상의 directory를 입력해야 합니다.");
  }

  if (input.commands.length === 0) {
    throw new Error("최소 하나 이상의 command를 입력해야 합니다.");
  }

  const existing = findProjectByName(home, input.name);
  const project: Project = {
    id: existing?.id ?? createId(),
    name: input.name,
    projectPaths,
    commands: input.commands,
    createdAt: existing?.createdAt ?? nowIso(),
  };

  saveProject(home, project);
  return project;
}

/** 프로젝트 이름, worktree path, run date 기준으로 CI job을 생성하고 command를 실행합니다. */
export function runProjectByName(home: string, input: RunProjectInput): Job {
  initializeDatabase(home);

  const project = findProjectByName(home, input.name);
  if (!project) {
    throw new Error(`프로젝트를 찾을 수 없습니다: ${input.name}`);
  }

  const target = selectRunTarget(project, input);
  return createAndRunJob(home, target.project, target.metadata);
}

/** 프로젝트와 worktree/date 메타데이터 기준으로 CI job을 생성하고 모든 command를 실행합니다. */
export function createAndRunJob(home: string, project: Project, metadata: RunMetadata): Job {
  const paths = resolvePaths(home);
  const projectLogDir = join(paths.logsDir, project.name);
  mkdirSync(projectLogDir, { recursive: true });

  const jobId = createId();
  const job: Job = {
    id: jobId,
    projectId: project.id,
    worktreePath: metadata.worktreePath,
    worktreeId: metadata.worktreeId,
    runDate: metadata.runDate,
    status: "queued",
    failedStep: null,
    exitCode: null,
    logPath: join(projectLogDir, `${jobId}.log`),
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };

  insertJob(home, job);
  appendLog(
    job.logPath,
    `Mini CI job ${job.id}\nproject: ${project.name}\nworktree id: ${metadata.worktreeId}\nworktree path: ${metadata.worktreePath}\nrun date: ${metadata.runDate}\npaths:\n${project.projectPaths.map((path) => `- ${path}`).join("\n")}\n\n`,
  );
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

/** 같은 worktree와 run date로 기존 job을 재실행합니다. */
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

  const projectForRun: Project = job.worktreePath === "all"
    ? project
    : { ...project, projectPaths: [job.worktreePath] };

  return createAndRunJob(home, projectForRun, {
    worktreePath: job.worktreePath,
    worktreeId: job.worktreeId,
    runDate: job.runDate,
  });
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
export function getJob(home: string, jobId: string): ReturnType<typeof findJobByIdWithProject> {
  initializeDatabase(home);
  return findJobByIdWithProject(home, jobId);
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

/** command 실행과 실패 중단 정책을 순서대로 수행합니다. */
function runJobSteps(project: Project, logPath: string): JobStepResult {
  for (const projectPath of project.projectPaths) {
    appendLog(logPath, `== ${projectPath}\n`);

    for (const command of project.commands) {
      appendLog(logPath, `$ ${command}\n`);
      const result = runShellCommand(command, projectPath);
      appendLog(logPath, result.stdout);
      appendLog(logPath, result.stderr);

      if (result.exitCode !== 0) {
        const failedStep = `${projectPath}: ${command}`;
        appendLog(logPath, `\nfailed: ${failedStep} (${result.exitCode})\n`);
        return { status: "failed", failedStep, exitCode: result.exitCode };
      }

      appendLog(logPath, "\n");
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

/** run 요청에서 실제 실행할 worktree와 저장할 날짜 메타데이터를 결정합니다. */
function selectRunTarget(project: Project, input: RunProjectInput): RunTarget {
  const runDate = input.runDate && input.runDate.trim() ? input.runDate.trim() : createRunDate();
  const projectRoot = input.projectRoot ?? resolveProjectRoot();
  const requestedWorktreePath = input.worktreePath && input.worktreePath.trim()
    ? input.worktreePath.trim()
    : null;

  if (requestedWorktreePath) {
    const worktreePath = resolveRegisteredWorktreePath(project, projectRoot, requestedWorktreePath);
    const worktreeId = worktreeIdFromProjectPath(projectRoot, worktreePath);

    return {
      project: { ...project, projectPaths: [worktreePath] },
      metadata: {
        worktreePath,
        worktreeId,
        runDate,
      },
    };
  }

  if (project.projectPaths.length === 1) {
    const worktreePath = project.projectPaths[0];
    return {
      project,
      metadata: {
        worktreePath,
        worktreeId: worktreeIdFromProjectPath(projectRoot, worktreePath),
        runDate,
      },
    };
  }

  return {
    project,
    metadata: {
      worktreePath: "all",
      worktreeId: "all",
      runDate,
    },
  };
}

/** 요청 worktree path가 등록된 project path 중 하나인지 확인하고 실제 경로를 반환합니다. */
function resolveRegisteredWorktreePath(project: Project, projectRoot: string, requestedWorktreePath: string): string {
  const worktreePath = resolveProjectPath(projectRoot, requestedWorktreePath);
  const registeredPaths = new Set(project.projectPaths.map((projectPath) => realpathSync(projectPath)));

  if (!registeredPaths.has(worktreePath)) {
    throw new Error(`등록된 worktree path가 아닙니다: ${requestedWorktreePath}`);
  }

  return worktreePath;
}

/** project root 아래 상대경로의 첫 segment를 worktree id로 사용합니다. */
function worktreeIdFromProjectPath(projectRootInput: string, projectPathInput: string): string {
  const projectRoot = realpathSync(resolve(projectRootInput));
  const projectPath = realpathSync(projectPathInput);
  const fromRoot = relative(projectRoot, projectPath);

  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return projectPathInput;
  }

  return fromRoot.split(sep).filter((segment) => segment.length > 0)[0] ?? fromRoot;
}

/** project root를 기준으로 여러 상대경로를 실제 실행 디렉터리 목록으로 해석합니다. */
function resolveProjectPaths(projectRootInput: string, projectPathInputs: readonly string[]): readonly string[] {
  return Array.from(new Set(projectPathInputs.map((projectPathInput) => {
    const projectPath = resolveProjectPath(projectRootInput, projectPathInput);
    if (!statSync(projectPath).isDirectory()) {
      throw new Error(`directory가 아닙니다: ${projectPath}`);
    }

    return projectPath;
  })));
}

/** project root를 기준으로 상대경로를 실제 실행 디렉터리로 해석합니다. */
function resolveProjectPath(projectRootInput: string, projectPathInput: string): string {
  const projectRoot = realpathSync(resolve(projectRootInput));
  const candidate = isAbsolute(projectPathInput)
    ? resolve(projectPathInput)
    : resolve(projectRoot, projectPathInput);
  const projectPath = realpathSync(candidate);
  const fromRoot = relative(projectRoot, projectPath);

  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`project path는 project root 아래여야 합니다: ${projectRoot}`);
  }

  return projectPath;
}
