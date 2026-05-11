import { appendFileSync, mkdirSync, realpathSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  branchRef,
  createId,
  nowIso,
  parsePostReceiveInput,
  type Job,
  type JobStepResult,
  type Project,
} from "./domains/ci/models.ts";
import {
  ensureMiniCiHome,
  findJobById,
  findLatestJob,
  findLatestJobForProject,
  findLatestProject,
  findProjectById,
  findProjects,
  findRecentJobs,
  findRecentJobsForProject,
  initializeDatabase,
  insertJob,
  resolvePaths,
  saveProject,
  updateJobStatus,
} from "./adapters/database/sqlite.ts";
import {
  checkoutCommit,
  ensureWorktree,
  installPostReceiveHook,
  isBareRepo,
  runShellCommand,
} from "./adapters/git/git.ts";

/** init 명령이 사용자에게 보여줄 생성 경로 결과입니다. */
export type InitResult = Readonly<{
  home: string;
  dbPath: string;
  logsDir: string;
  worktreesDir: string;
}>;

/** project attach 명령이 도메인 설정 생성에 넘기는 검증된 입력입니다. */
export type AttachProjectInput = Readonly<{
  projectPath: string;
  bareRepoPath: string;
  branch: string;
  commands: readonly string[];
  miniCiBin: string;
}>;

/** 환경변수와 기본값을 기준으로 Mini CI 홈 경로를 결정합니다. */
export function resolveMiniCiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINI_CI_HOME ? resolve(env.MINI_CI_HOME) : join(homedir(), ".mini-ci");
}

/** Mini CI 홈, DB, 로그 디렉터리, worktree 디렉터리를 초기화합니다. */
export function initMiniCi(home: string): InitResult {
  const paths = ensureMiniCiHome(home);
  initializeDatabase(home);

  return {
    home: paths.home,
    dbPath: paths.dbPath,
    logsDir: paths.logsDir,
    worktreesDir: paths.worktreesDir,
  };
}

/** 기존 local bare repo를 프로젝트에 연결하고 hook과 CI worktree를 준비합니다. */
export function attachProject(home: string, input: AttachProjectInput): Project {
  initMiniCi(home);

  const projectPath = realpathSync(resolve(input.projectPath));
  const bareRepoPath = realpathSync(resolve(input.bareRepoPath));
  if (!isBareRepo(bareRepoPath)) {
    throw new Error(`bare repo가 아닙니다: ${bareRepoPath}`);
  }

  if (input.commands.length === 0) {
    throw new Error("최소 하나 이상의 --cmd 값을 입력해야 합니다.");
  }

  const paths = resolvePaths(home);
  const name = basename(projectPath);
  const project: Project = {
    id: createId(),
    name,
    projectPath,
    bareRepoPath,
    branch: input.branch,
    commands: input.commands,
    worktreePath: join(paths.worktreesDir, name),
    createdAt: nowIso(),
  };

  ensureWorktree({
    bareRepoPath: project.bareRepoPath,
    worktreePath: project.worktreePath,
    branch: project.branch,
  });
  saveProject(home, project);
  installPostReceiveHook(project.bareRepoPath, {
    projectId: project.id,
    miniCiHome: home,
    miniCiBin: input.miniCiBin,
  });

  return project;
}

/** post-receive 입력에서 대상 브랜치 업데이트를 찾아 job을 생성하고 실행합니다. */
export function handlePostReceive(home: string, projectId: string, input: string): readonly Job[] {
  initializeDatabase(home);

  const project = findProjectById(home, projectId);
  if (!project) {
    throw new Error(`프로젝트를 찾을 수 없습니다: ${projectId}`);
  }

  const updates = parsePostReceiveInput(input);
  const targetRef = branchRef(project.branch);
  const jobs: Job[] = [];

  for (const update of updates) {
    if (update.ref !== targetRef) {
      continue;
    }

    jobs.push(createAndRunJob(home, project, update.newCommit));
  }

  return jobs;
}

/** 프로젝트와 commit 기준으로 CI job을 생성하고 모든 command를 실행합니다. */
export function createAndRunJob(home: string, project: Project, commitSha: string): Job {
  const paths = resolvePaths(home);
  const projectLogDir = join(paths.logsDir, project.name);
  mkdirSync(projectLogDir, { recursive: true });

  const jobId = createId();
  const job: Job = {
    id: jobId,
    projectId: project.id,
    commitSha,
    status: "queued",
    failedStep: null,
    exitCode: null,
    logPath: join(projectLogDir, `${jobId}.log`),
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };

  insertJob(home, job);
  appendLog(job.logPath, `Mini CI job ${job.id}\nproject: ${project.name}\ncommit: ${commitSha}\n\n`);
  updateJobStatus(home, job.id, {
    status: "running",
    failedStep: null,
    exitCode: null,
    startedAt: nowIso(),
  });

  const result = runJobSteps(project, job.logPath, commitSha);
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

/** 같은 commit으로 기존 job을 재실행합니다. */
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

  return createAndRunJob(home, project, job.commitSha);
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

/** 대시보드 API에서 사용할 프로젝트별 최신 job을 조회합니다. */
export function getLatestJobForProject(home: string, projectId: string): ReturnType<typeof findLatestJobForProject> {
  initializeDatabase(home);
  return findLatestJobForProject(home, projectId);
}

/** 대시보드 API에서 사용할 최근 job 실행 이력을 조회합니다. */
export function getRecentJobs(home: string): ReturnType<typeof findRecentJobs> {
  initializeDatabase(home);
  return findRecentJobs(home);
}

/** 대시보드 API에서 사용할 프로젝트별 job 이력을 조회합니다. */
export function getRecentJobsForProject(
  home: string,
  projectId: string,
): ReturnType<typeof findRecentJobsForProject> {
  initializeDatabase(home);
  return findRecentJobsForProject(home, projectId);
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

/** CLI run-job 명령에서 사용할 최신 프로젝트 또는 지정 프로젝트를 조회합니다. */
export function runJobForProject(home: string, input: Readonly<{ projectId?: string; commitSha: string }>): Job {
  initializeDatabase(home);

  const project = input.projectId ? findProjectById(home, input.projectId) : findLatestProject(home);
  if (!project) {
    throw new Error("실행할 프로젝트를 찾을 수 없습니다.");
  }

  return createAndRunJob(home, project, input.commitSha);
}

/** checkout, command 실행, 실패 중단 정책을 순서대로 수행합니다. */
function runJobSteps(project: Project, logPath: string, commitSha: string): JobStepResult {
  try {
    appendLog(logPath, `$ git checkout --detach ${commitSha}\n`);
    checkoutCommit(project.worktreePath, commitSha);
  } catch (error) {
    appendLog(logPath, `checkout failed\n${formatError(error)}\n`);
    return { status: "failed", failedStep: "checkout", exitCode: 1 };
  }

  for (const command of project.commands) {
    appendLog(logPath, `\n$ ${command}\n`);
    const result = runShellCommand(command, project.worktreePath);
    appendLog(logPath, result.stdout);
    appendLog(logPath, result.stderr);

    if (result.exitCode !== 0) {
      appendLog(logPath, `\nfailed: ${command} (${result.exitCode})\n`);
      return { status: "failed", failedStep: command, exitCode: result.exitCode };
    }
  }

  appendLog(logPath, "\nsuccess\n");
  return { status: "success", failedStep: null, exitCode: 0 };
}

/** 로그 파일에 문자열을 누적합니다. */
function appendLog(path: string, text: string): void {
  appendFileSync(path, text);
}

/** 알 수 없는 오류 값을 CLI와 로그에 표시할 문자열로 변환합니다. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
