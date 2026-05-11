import { spawnSync } from "node:child_process";

/** shell command 실행 후 로그와 DB 갱신에 사용하는 경계 결과입니다. */
export type ShellCommandResult = Readonly<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/** 지정된 디렉터리에서 shell command를 실행하고 출력을 반환합니다. */
export function runShellCommand(command: string, cwd: string): ShellCommandResult {
  const result = spawnSync(command, {
    cwd,
    env: { ...process.env },
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
