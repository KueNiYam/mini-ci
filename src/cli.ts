import {
  ensureProjectRoot,
  initMiniCi,
  resolveMiniCiHome,
  resolveProjectRoot,
} from "./app.ts";
import { startDashboard } from "./adapters/http/dashboard.ts";

/** CLI parser가 명령 처리에 넘기는 옵션/인자 구조입니다. */
type ParsedOptions = Readonly<{
  values: Readonly<Record<string, string>>;
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
    const projectRoot = ensureProjectRoot(resolveProjectRoot());
    initMiniCi(home);
    startDashboard({
      home,
      host,
      port,
      projectRoot,
    });
    return;
  }

  throw new Error(`알 수 없는 명령입니다: ${argv.join(" ")}`);
}

/** 반복 옵션을 포함한 간단한 CLI 옵션을 파싱합니다. */
function parseOptions(argv: readonly string[]): ParsedOptions {
  const values: Record<string, string> = {};
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
    values[key] = value;
  }

  return { values, positionals };
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

After start:
  Project management: /admin
  Run: POST /api/projects/:name/runs with worktreePath and runDate
  Project root: ~/.codex/worktrees or MINI_CI_PROJECT_ROOT
`);
}

await main();
