import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  attachProject,
  handlePostReceive,
  initMiniCi,
  resolveMiniCiHome,
  runJobForProject,
} from "./app.ts";
import { startDashboard } from "./adapters/http/dashboard.ts";

/** CLI parser가 명령 처리에 넘기는 옵션/인자 구조입니다. */
type ParsedOptions = Readonly<{
  values: Readonly<Record<string, string>>;
  lists: Readonly<Record<string, readonly string[]>>;
  positionals: readonly string[];
}>;

/** CLI 프로세스의 진입점입니다. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    await routeCommand(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/** 최상위 명령어를 해석하고 실제 작업 함수로 연결합니다. */
async function routeCommand(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const home = resolveMiniCiHome();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const result = initMiniCi(home);
    console.log(`~/.mini-ci/`);
    console.log(`  ${basenameOnly(result.dbPath)}`);
    console.log(`  logs/`);
    console.log(`  worktrees/`);
    console.log("");
    console.log("Dashboard: http://localhost:4177");
    return;
  }

  if (command === "start") {
    const options = parseOptions(rest);
    const port = Number(options.values.port ?? "4177");
    initMiniCi(home);
    startDashboard({ home, port });
    return;
  }

  if (command === "project" && rest[0] === "attach") {
    const options = parseOptions(rest.slice(1));
    const projectPath = options.positionals[0] ?? ".";
    const bareRepoPath = options.values["bare-repo"];
    if (!bareRepoPath) {
      throw new Error("--bare-repo 값이 필요합니다.");
    }

    const project = attachProject(home, {
      projectPath,
      bareRepoPath,
      branch: options.values.branch ?? "main",
      commands: options.lists.cmd ?? [],
      miniCiBin: process.env.MINI_CI_BIN ?? resolve(dirname(fileURLToPath(import.meta.url)), "../bin/mini-ci"),
    });

    console.log(`project registered: ${project.name}`);
    console.log(`using bare repo: ${project.bareRepoPath}`);
    console.log("post-receive hook installed");
    console.log(`CI worktree ready: ${project.worktreePath}`);
    return;
  }

  if (command === "hook" && rest[0] === "post-receive") {
    const options = parseOptions(rest.slice(1));
    const projectId = options.values["project-id"];
    if (!projectId) {
      throw new Error("--project-id 값이 필요합니다.");
    }

    const jobs = handlePostReceive(home, projectId, readStdin());
    for (const job of jobs) {
      console.log("job created");
      console.log(`commit: ${job.commitSha}`);
      console.log(`status: ${job.status}`);
    }
    return;
  }

  if (command === "run-job") {
    const options = parseOptions(rest);
    const commitSha = options.values.commit;
    if (!commitSha) {
      throw new Error("--commit 값이 필요합니다.");
    }

    const job = runJobForProject(home, {
      projectId: options.values["project-id"],
      commitSha,
    });
    console.log("job created");
    console.log(`commit: ${job.commitSha}`);
    console.log(`status: ${job.status}`);
    return;
  }

  throw new Error(`알 수 없는 명령입니다: ${argv.join(" ")}`);
}

/** 반복 옵션을 포함한 간단한 CLI 옵션을 파싱합니다. */
function parseOptions(argv: readonly string[]): ParsedOptions {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} 옵션 값이 필요합니다.`);
    }

    index += 1;
    if (key === "cmd") {
      lists.cmd = [...(lists.cmd ?? []), value];
    } else {
      values[key] = value;
    }
  }

  return { values, lists, positionals };
}

/** 표준 입력 전체를 문자열로 읽습니다. */
function readStdin(): string {
  return readFileSync(0, "utf8");
}

/** 경로 출력에서 파일명만 표시하기 위한 작은 변환 함수입니다. */
function basenameOnly(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** 사용자에게 보여줄 CLI 도움말을 출력합니다. */
function printHelp(): void {
  console.log(`Mini CI

Usage:
  mini-ci init
  mini-ci start [--port 4177]
  mini-ci project attach <path> --bare-repo <path> [--branch main] --cmd <command>
  mini-ci run-job --commit <sha> [--project-id <id>]
`);
}

await main();
