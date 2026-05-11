import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/** shell command 실행 후 로그와 DB 갱신에 사용하는 경계 결과입니다. */
export type ShellCommandResult = Readonly<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const MINI_CI_HOOK_MARKER = "# mini-ci managed post-receive hook";

/** 경로가 Git bare repo인지 확인합니다. */
export function isBareRepo(path: string): boolean {
  const result = spawnSync("git", ["-C", path, "rev-parse", "--is-bare-repository"], {
    encoding: "utf8",
  });

  return result.status === 0 && result.stdout.trim() === "true";
}

/** bare repo에 연결된 CI 전용 worktree를 준비합니다. */
export function ensureWorktree(input: Readonly<{ bareRepoPath: string; worktreePath: string; branch: string }>): void {
  if (existsSync(join(input.worktreePath, ".git"))) {
    runGit(["checkout", "--detach", input.branch], input.worktreePath);
    return;
  }

  mkdirSync(dirname(input.worktreePath), { recursive: true });
  runGit([
    "--git-dir",
    input.bareRepoPath,
    "worktree",
    "add",
    "--force",
    "--detach",
    input.worktreePath,
    input.branch,
  ]);
}

/** worktree를 지정된 commit으로 checkout합니다. */
export function checkoutCommit(worktreePath: string, commitSha: string): void {
  runGit(["checkout", "--detach", commitSha], worktreePath);
}

/** bare repo의 post-receive hook을 Mini CI job 등록용으로 설치합니다. */
export function installPostReceiveHook(
  bareRepoPath: string,
  input: Readonly<{ projectId: string; miniCiHome: string; miniCiBin: string }>,
): string {
  const hookPath = join(bareRepoPath, "hooks", "post-receive");
  mkdirSync(dirname(hookPath), { recursive: true });

  if (existsSync(hookPath)) {
    const current = readFileSync(hookPath, "utf8");
    if (!current.includes(MINI_CI_HOOK_MARKER)) {
      const backupPath = `${hookPath}.mini-ci-backup-${Date.now()}`;
      writeFileSync(backupPath, current);
    }
  }

  const hook = `#!/usr/bin/env bash
set -euo pipefail
${MINI_CI_HOOK_MARKER}
export MINI_CI_HOME=${shellQuote(input.miniCiHome)}
exec ${shellQuote(input.miniCiBin)} hook post-receive --project-id ${shellQuote(input.projectId)}
`;

  writeFileSync(hookPath, hook);
  chmodSync(hookPath, 0o755);
  return hookPath;
}

/** 지정된 worktree에서 shell command를 실행하고 출력을 반환합니다. */
export function runShellCommand(command: string, cwd: string): ShellCommandResult {
  const result = spawnSync(command, {
    cwd,
    env: cleanGitHookEnv(),
    shell: true,
    encoding: "utf8",
  });

  return {
    command,
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Git 명령을 실행하고 실패 시 stderr를 포함한 오류를 던집니다. */
function runGit(args: readonly string[], cwd?: string): string {
  const result = spawnSync("git", [...args], {
    cwd,
    env: cleanGitHookEnv(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} 실행에 실패했습니다.`);
  }

  return result.stdout;
}

/** shell script에 안전하게 넣을 문자열 literal을 만듭니다. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Git hook에서 상속되는 저장소 환경변수를 제거한 실행 환경을 만듭니다. */
function cleanGitHookEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  return env;
}
