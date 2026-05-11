import {
  addProject,
  initMiniCi,
  resolveMiniCiHome,
  runProjectByName,
  setTriggerToken,
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
    console.log("");
    console.log("Dashboard: http://localhost:4177");
    return;
  }

  if (command === "start") {
    const options = parseOptions(rest);
    const port = Number(options.values.port ?? "4177");
    const host = options.values.host ?? "127.0.0.1";
    initMiniCi(home);
    startDashboard({
      home,
      host,
      port,
      adminToken: process.env.MINI_CI_ADMIN_TOKEN,
    });
    return;
  }

  if (command === "project" && rest[0] === "add") {
    const options = parseOptions(rest.slice(1));
    const name = options.positionals[0];
    const projectPath = options.values.path;
    if (!name) {
      throw new Error("프로젝트 이름이 필요합니다.");
    }

    if (!projectPath) {
      throw new Error("--path 값이 필요합니다.");
    }

    const project = addProject(home, {
      name,
      projectPath,
      commands: options.lists.cmd ?? [],
    });

    console.log(`project registered: ${project.name}`);
    console.log(`path: ${project.projectPath}`);
    return;
  }

  if (command === "run") {
    const options = parseOptions(rest);
    const name = options.values.project ?? options.positionals[0];
    if (!name) {
      throw new Error("--project 값 또는 프로젝트 이름이 필요합니다.");
    }

    const job = runProjectByName(home, {
      name,
      ref: options.values.ref,
    });
    console.log("job created");
    console.log(`project: ${name}`);
    console.log(`ref: ${job.ref}`);
    console.log(`status: ${job.status}`);
    return;
  }

  if (command === "token" && rest[0] === "create") {
    const token = setTriggerToken(home);
    console.log(token);
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

/** 경로 출력에서 파일명만 표시하기 위한 작은 변환 함수입니다. */
function basenameOnly(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** 사용자에게 보여줄 CLI 도움말을 출력합니다. */
function printHelp(): void {
  console.log(`Mini CI

Usage:
  mini-ci init
  mini-ci start [--host 127.0.0.1] [--port 4177]
  mini-ci project add <name> --path <directory> --cmd <command>
  mini-ci run --project <name> [--ref <ref>]
  mini-ci token create
`);
}

await main();
