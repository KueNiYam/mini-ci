import { spawn } from "node:child_process";

/** shell command 실행 후 로그와 DB 갱신에 사용하는 경계 결과입니다. */
export type ShellCommandResult = Readonly<{
  command: string;
  exitCode: number;
}>;

/** command 출력 chunk를 로그 저장소로 흘려보내는 callback입니다. */
export type ShellOutputSink = (chunk: string) => void;

/** 지정된 디렉터리에서 shell command를 실행하고 stdout/stderr를 즉시 전달합니다. */
export function runShellCommand(
  command: string,
  cwd: string,
  onOutput: ShellOutputSink,
): Promise<ShellCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env },
      shell: true,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onOutput(chunk));
    child.stderr.on("data", (chunk: string) => onOutput(chunk));

    child.on("error", (error) => {
      onOutput(`\nspawn error: ${error.message}\n`);
      resolveResult({
        command,
        exitCode: 1,
      });
    });

    child.on("close", (code) => {
      resolveResult({
        command,
        exitCode: typeof code === "number" ? code : 1,
      });
    });
  });
}
