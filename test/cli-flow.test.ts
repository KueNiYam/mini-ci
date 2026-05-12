import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject,
  getJob,
  getProjects,
  getRecentJobsForProjectName,
  recoverStaleRunningJobs,
  runProjectByName,
} from "../src/app.ts";
import { initializeDatabase, insertJob, saveProject } from "../src/adapters/database/sqlite.ts";
import { listProjectRootEntries, projectPathsForName, resolveAdminProjectPaths } from "../src/adapters/http/dashboard.ts";
import { runShellCommand } from "../src/adapters/process/shell.ts";
import type { Job, Project } from "../src/domains/ci/models.ts";

test("directory project에서 CI job을 실행한다", async () => {
  // Given:
  // When:
  // Then:
  const root = await mkdtemp(join(tmpdir(), "mini-ci-dir-"));
  const home = join(root, "home");
  const projectRoot = join(root, "worktrees");
  const projectPathA = join(projectRoot, "a", "app");
  const projectPathB = join(projectRoot, "b", "app");
  mkdirSync(projectPathA, { recursive: true });
  mkdirSync(projectPathB, { recursive: true });
  writeFileSync(join(projectPathA, "README.md"), "hello\n");
  writeFileSync(join(projectPathB, "README.md"), "hello\n");

  addProject(home, {
    name: "app",
    projectRoot,
    projectPaths: ["a/app", "b/app"],
    commands: ["printf ok > ci-result.txt"],
  });

  const job = runProjectByName(home, {
    name: "app",
    projectRoot,
    worktreePath: "a/app",
    runDate: "20260511120000",
  });
  const finishedJob = await waitForJob(home, job.id, "success");

  const resultPathA = join(projectPathA, "ci-result.txt");
  const resultPathB = join(projectPathB, "ci-result.txt");
  assert.equal(job.status, "queued");
  assert.equal(finishedJob.status, "success");
  assert.equal(finishedJob.worktreeId, "a");
  assert.equal(finishedJob.runDate, "20260511120000");
  assert.equal(existsSync(resultPathA), true);
  assert.equal(existsSync(resultPathB), false);
  assert.equal(readFileSync(resultPathA, "utf8"), "ok");
});

test("shell command 출력은 실행 중 streaming callback으로 전달된다", async () => {
  // Given:
  // When:
  // Then:
  const root = await mkdtemp(join(tmpdir(), "mini-ci-stream-"));
  const chunks: string[] = [];
  let resolved = false;

  const resultPromise = runShellCommand(
    "node -e \"process.stdout.write('first\\\\n'); setTimeout(() => process.stdout.write('second\\\\n'), 80)\"",
    root,
    (chunk) => chunks.push(chunk),
  ).then((result) => {
    resolved = true;
    return result;
  });

  await waitUntil(() => chunks.join("").includes("first"));
  assert.equal(resolved, false);

  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.match(chunks.join(""), /first\nsecond/);
});

test("서버 시작 복구는 stale running job을 interrupted로 전환한다", async () => {
  // Given:
  // When:
  // Then:
  const root = await mkdtemp(join(tmpdir(), "mini-ci-stale-"));
  const home = join(root, "home");
  const project = createProject("project-a", "app-a", join(root, "app-a"));
  const logPath = join(root, "running.log");
  mkdirSync(join(root, "app-a"), { recursive: true });
  writeFileSync(logPath, "running\n");

  initializeDatabase(home);
  saveProject(home, project);
  insertJob(home, createJob("job-running", project.id, "worktree-a", "20260511000100", logPath, "running"));

  assert.equal(recoverStaleRunningJobs(home), 1);
  const job = getJob(home, "job-running");
  assert.equal(job?.status, "interrupted");
  assert.equal(job?.failedStep, "server restart");
  assert.match(readFileSync(logPath, "utf8"), /interrupted: server restarted/);
});

test("프로젝트 등록은 기준 디렉터리 밖의 경로를 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-root-"));
  const home = join(root, "home");
  const projectRoot = join(root, "worktrees");
  const outsidePath = join(root, "outside");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(outsidePath);

  assert.throws(
    () => addProject(home, {
      name: "outside",
      projectRoot,
      projectPaths: [outsidePath],
      commands: ["true"],
    }),
    /project root 아래/,
  );
});

test("Admin 후보는 해시 폴더 안의 프로젝트명 segment로 디렉터리를 묶는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-root-list-"));
  const projectRoot = join(root, "worktrees");
  const directStorybook = join(projectRoot, "655f", "storyboard");
  const nestedStorybook = join(projectRoot, "7490", "storyboard", "current");
  mkdirSync(directStorybook, { recursive: true });
  mkdirSync(nestedStorybook, { recursive: true });
  writeFileSync(join(directStorybook, "README.md"), "direct\n");
  writeFileSync(join(nestedStorybook, "README.md"), "nested\n");

  const entries = listProjectRootEntries(projectRoot);

  assert.deepEqual(
    entries.filter((entry) => entry.projectName === "storyboard").map((entry) => entry.path),
    ["655f/storyboard", "7490/storyboard/current"],
  );
  assert.deepEqual(
    projectPathsForName(projectRoot, "storyboard"),
    ["655f/storyboard", "7490/storyboard/current"],
  );
});

test("Admin 프로젝트 등록은 paths 없이 프로젝트명으로 디렉터리를 자동 탐지한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-admin-auto-paths-"));
  const projectRoot = join(root, "worktrees");
  const pathA = join(projectRoot, "1cf2", "storyboard");
  const pathB = join(projectRoot, "655f", "storyboard");
  mkdirSync(pathA, { recursive: true });
  mkdirSync(pathB, { recursive: true });
  writeFileSync(join(pathA, "README.md"), "a\n");
  writeFileSync(join(pathB, "README.md"), "b\n");

  assert.deepEqual(
    resolveAdminProjectPaths(projectRoot, "storyboard", null),
    ["1cf2/storyboard", "655f/storyboard"],
  );
  assert.deepEqual(
    resolveAdminProjectPaths(projectRoot, "storyboard", ["custom/storyboard"]),
    ["custom/storyboard"],
  );
});

test("여러 프로젝트의 job을 프로젝트별로 조회한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-projects-"));
  const home = join(root, "home");
  const projectA = createProject("project-a", "app-a", join(root, "app-a"));
  const projectB = createProject("project-b", "app-b", join(root, "app-b"));

  initializeDatabase(home);
  saveProject(home, projectA);
  saveProject(home, projectB);
  insertJob(home, createJob("job-a", projectA.id, "worktree-a", "20260511000100", join(root, "a.log")));
  insertJob(home, createJob("job-b", projectB.id, "worktree-b", "20260511000200", join(root, "b.log")));

  assert.deepEqual(
    getProjects(home).map((project) => project.name),
    ["app-a", "app-b"],
  );
  assert.deepEqual(
    getRecentJobsForProjectName(home, projectA.name).map((job) => `${job.worktreeId}:${job.runDate}`),
    ["worktree-a:20260511000100"],
  );
  assert.equal(getJob(home, "job-a")?.projectName, "app-a");
  assert.deepEqual(
    getRecentJobsForProjectName(home, projectB.name).map((job) => `${job.worktreeId}:${job.runDate}`),
    ["worktree-b:20260511000200"],
  );
});

test("CLI는 init/start와 서버 안내만 노출한다", () => {
  const result = spawnSync(join(process.cwd(), "bin/mini-ci"), ["--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /mini-ci init/);
  assert.match(result.stdout, /mini-ci start/);
  assert.match(result.stdout, /Project management: \/admin/);
  assert.doesNotMatch(result.stdout, /project add/);
  assert.doesNotMatch(result.stdout, /token create/);
  assert.doesNotMatch(result.stdout, /mini-ci run/);
});

/** 테스트용 프로젝트 모델을 만듭니다. */
function createProject(id: string, name: string, projectPath: string): Project {
  return {
    id,
    name,
    projectPaths: [projectPath],
    commands: ["printf ok > ci-result.txt"],
    createdAt: `2026-05-11T00:00:0${id.endsWith("a") ? "1" : "2"}.000Z`,
  };
}

/** 테스트용 job 모델을 만듭니다. */
function createJob(
  id: string,
  projectId: string,
  worktreeId: string,
  runDate: string,
  logPath: string,
  status: Job["status"] = "success",
): Job {
  return {
    id,
    projectId,
    worktreePath: `/tmp/${worktreeId}`,
    worktreeId,
    runDate,
    status,
    failedStep: null,
    exitCode: status === "success" ? 0 : null,
    logPath,
    createdAt: id.endsWith("a") ? "2026-05-11T00:00:01.000Z" : "2026-05-11T00:00:02.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

/** 조건이 true가 될 때까지 짧게 polling합니다. */
async function waitUntil(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("조건 대기 시간이 초과되었습니다.");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** job이 원하는 상태가 될 때까지 조회합니다. */
async function waitForJob(home: string, jobId: string, status: Job["status"]): Promise<Job & Readonly<{ projectName: string }>> {
  let latest: (Job & Readonly<{ projectName: string }>) | null = null;
  await waitUntil(() => {
    latest = getJob(home, jobId);
    return latest?.status === status;
  }, 1500);

  if (!latest) {
    throw new Error(`job을 찾을 수 없습니다: ${jobId}`);
  }

  return latest;
}
