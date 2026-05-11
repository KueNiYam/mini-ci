import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
