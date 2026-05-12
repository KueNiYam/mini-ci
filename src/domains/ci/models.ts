import { randomBytes } from "node:crypto";

export const JOB_STATUSES = ["queued", "running", "success", "failed"] as const;

/** job 실행 상태의 단일 출처입니다. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Mini CI에 연결된 개발 프로젝트와 CI 실행 설정입니다. */
export type Project = Readonly<{
  id: string;
  name: string;
  projectPaths: readonly string[];
  commands: readonly string[];
  createdAt: string;
}>;

/** 특정 worktree와 실행 날짜에 대해 생성된 CI 작업의 저장 모델입니다. */
export type Job = Readonly<{
  id: string;
  projectId: string;
  worktreePath: string;
  worktreeId: string;
  runDate: string;
  status: JobStatus;
  failedStep: string | null;
  exitCode: number | null;
  logPath: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}>;

/** command 실행 흐름이 DB 상태 갱신에 넘기는 최종 결과입니다. */
export type JobStepResult = Readonly<{
  status: "success" | "failed";
  failedStep: string | null;
  exitCode: number | null;
}>;

/** 현재 시각을 저장용 ISO 문자열로 변환합니다. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** 사용자가 날짜를 주지 않았을 때 저장할 시간 기반 run date를 만듭니다. */
export function createRunDate(now: Date = new Date()): string {
  return now.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 새 도메인 식별자를 UUIDv7 형식으로 생성합니다. */
export function createId(now: Date = new Date()): string {
  return formatUuidV7(now.getTime(), randomBytes(10));
}

/** 주입받은 시간과 난수로 UUIDv7 문자열을 만듭니다. */
export function formatUuidV7(timestampMs: number, random: Uint8Array): string {
  if (random.length < 10) {
    throw new Error("UUIDv7 생성에는 최소 10바이트 난수가 필요합니다.");
  }

  const bytes = new Uint8Array(16);
  bytes[0] = (timestampMs / 0x10000000000) & 0xff;
  bytes[1] = (timestampMs / 0x100000000) & 0xff;
  bytes[2] = (timestampMs / 0x1000000) & 0xff;
  bytes[3] = (timestampMs / 0x10000) & 0xff;
  bytes[4] = (timestampMs / 0x100) & 0xff;
  bytes[5] = timestampMs & 0xff;
  bytes[6] = 0x70 | (random[0] & 0x0f);
  bytes[7] = random[1];
  bytes[8] = 0x80 | (random[2] & 0x3f);
  bytes[9] = random[3];
  bytes[10] = random[4];
  bytes[11] = random[5];
  bytes[12] = random[6];
  bytes[13] = random[7];
  bytes[14] = random[8];
  bytes[15] = random[9];

  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}
