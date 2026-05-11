import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { getProjects, getRecentJobsForProject } from "../src/app.ts";
import { initializeDatabase, insertJob, saveProject } from "../src/adapters/database/sqlite.ts";
import type { Job, Project } from "../src/domains/ci/models.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "mini-ci");

test("local bare repo push가 hook을 통해 CI job을 실행한다", async () => {
  // Given:
  // When:
  // Then:
  const root = await mkdtemp(join(tmpdir(), "mini-ci-flow-"));
  const home = join(root, "home");
  const bareRepo = join(root, "app.git");
  const devRepo = join(root, "app");
  const env = {
    ...process.env,
    MINI_CI_HOME: home,
    MINI_CI_BIN: CLI,
  };

  run(CLI, ["init"], { cwd: REPO_ROOT, env });
  run("git", ["init", "--bare", bareRepo], { cwd: root, env });
  mkdirSync(devRepo);
  run("git", ["init"], { cwd: devRepo, env });
  run("git", ["config", "user.email", "mini-ci@example.test"], { cwd: devRepo, env });
  run("git", ["config", "user.name", "Mini CI Test"], { cwd: devRepo, env });
  writeFileSync(join(devRepo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: devRepo, env });
  run("git", ["commit", "-m", "init"], { cwd: devRepo, env });
  run("git", ["branch", "-M", "main"], { cwd: devRepo, env });
  run("git", ["remote", "add", "origin", bareRepo], { cwd: devRepo, env });
  run("git", ["push", "origin", "main"], { cwd: devRepo, env });

  run(
    CLI,
    [
      "project",
      "attach",
      devRepo,
      "--bare-repo",
      bareRepo,
      "--branch",
      "main",
      "--cmd",
      "printf ok > ci-result.txt",
    ],
    { cwd: REPO_ROOT, env },
  );

  writeFileSync(join(devRepo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: devRepo, env });
  run("git", ["commit", "-m", "change"], { cwd: devRepo, env });
  run("git", ["push", "origin", "main"], { cwd: devRepo, env });

  const resultPath = join(home, "worktrees", "app", "ci-result.txt");
  assert.equal(existsSync(resultPath), true);
  assert.equal(readFileSync(resultPath, "utf8"), "ok");

  const jobs = querySql(home, "SELECT status, exit_code FROM jobs ORDER BY created_at DESC LIMIT 1;");
  assert.deepEqual(jobs, [{ status: "success", exit_code: 0 }]);
});

test("여러 프로젝트의 job을 프로젝트별로 조회한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-projects-"));
  const home = join(root, "home");
  const projectA = createProject("project-a", "app-a", root);
  const projectB = createProject("project-b", "app-b", root);

  initializeDatabase(home);
  saveProject(home, projectA);
  saveProject(home, projectB);
  insertJob(home, createJob("job-a", projectA.id, "commit-a", join(root, "a.log")));
  insertJob(home, createJob("job-b", projectB.id, "commit-b", join(root, "b.log")));

  assert.deepEqual(
    getProjects(home).map((project) => project.name),
    ["app-a", "app-b"],
  );
  assert.deepEqual(
    getRecentJobsForProject(home, projectA.id).map((job) => job.commitSha),
    ["commit-a"],
  );
  assert.deepEqual(
    getRecentJobsForProject(home, projectB.id).map((job) => job.commitSha),
    ["commit-b"],
  );
});

/** 외부 명령을 실행하고 실패하면 테스트 실패로 처리합니다. */
function run(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>,
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    [
      `$ ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr,
    ].join("\n"),
  );

  return result.stdout;
}

/** 테스트 DB에서 JSON row 배열을 조회합니다. */
function querySql(home: string, sql: string): readonly Record<string, unknown>[] {
  const result = spawnSync("sqlite3", ["-json", join(home, "mini-ci.sqlite"), sql], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as readonly Record<string, unknown>[];
}

/** 테스트용 프로젝트 모델을 만듭니다. */
function createProject(id: string, name: string, root: string): Project {
  return {
    id,
    name,
    projectPath: join(root, name),
    bareRepoPath: join(root, `${name}.git`),
    branch: "main",
    commands: ["npm test"],
    worktreePath: join(root, "worktrees", name),
    createdAt: `2026-05-11T00:00:0${id.endsWith("a") ? "1" : "2"}.000Z`,
  };
}

/** 테스트용 job 모델을 만듭니다. */
function createJob(id: string, projectId: string, commitSha: string, logPath: string): Job {
  return {
    id,
    projectId,
    commitSha,
    status: "success",
    failedStep: null,
    exitCode: 0,
    logPath,
    createdAt: id.endsWith("a") ? "2026-05-11T00:00:01.000Z" : "2026-05-11T00:00:02.000Z",
    startedAt: null,
    finishedAt: null,
  };
}
