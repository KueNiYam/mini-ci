import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  addProject,
  getJob,
  getJobLog,
  getLatestJob,
  getLatestJobForProjectName,
  getProjects,
  getRecentJobs,
  getRecentJobsForProjectName,
  rerunJob,
  resolveProjectRoot,
  runProjectByName,
} from "../../app.ts";
import type { Job } from "../../domains/ci/models.ts";

/** 대시보드 서버 실행에 필요한 로컬 런타임 설정입니다. */
export type DashboardOptions = Readonly<{
  home: string;
  host: string;
  port: number;
  projectRoot?: string;
}>;

/** Admin API에서 프로젝트 등록에 사용하는 검증된 요청 값입니다. */
type AdminProjectRequest = Readonly<{
  name: string;
  projectPaths: readonly string[] | null;
  commands: readonly string[];
}>;

/** Admin 프로젝트 등록 요청의 파싱 결과입니다. */
type AdminProjectParseResult =
  | Readonly<{ ok: true; value: AdminProjectRequest }>
  | Readonly<{ ok: false; error: string }>;

/** Admin UI가 기준 디렉터리 후보 목록으로 표시하는 상대경로입니다. */
type ProjectRootEntry = Readonly<{
  path: string;
  projectName: string;
}>;

/** 프로젝트 루트로 판단할 때 사용하는 대표 파일 목록입니다. */
const PROJECT_MARKER_FILES = [
  ".git",
  "Cargo.toml",
  "Makefile",
  "README.html",
  "README.md",
  "go.mod",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
] as const;

/** Mini CI 대시보드와 JSON API 서버를 시작합니다. */
export function startDashboard(options: DashboardOptions): Server {
  const server = createServer((request, response) => {
    handleRequest(options, request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(`Dashboard: http://${options.host}:${options.port}`);
  });
  return server;
}

/** 요청 경로에 맞는 dashboard HTML 또는 API 응답을 반환합니다. */
async function handleRequest(
  options: DashboardOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const projectRoot = options.projectRoot ?? resolveProjectRoot();

  if (method === "GET" && url.pathname === "/") {
    sendHtml(response, dashboardHtml(projectRoot));
    return;
  }

  if (method === "GET" && url.pathname === "/admin") {
    sendHtml(response, adminHtml(projectRoot));
    return;
  }

  const jobPageMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPageMatch) {
    const job = getJob(options.home, jobPageMatch[1]);
    const log = job ? getJobLog(options.home, job.id) : null;

    if (!job || log === null) {
      sendHtml(response, notFoundHtml("Job not found"), 404);
      return;
    }

    sendHtml(response, jobDetailHtml(projectRoot, job, log));
    return;
  }

  if (method === "GET" && url.pathname === "/api/admin/project-root") {
    sendJson(response, 200, {
      path: projectRoot,
      displayPath: displayPathForUser(projectRoot),
      entries: listProjectRootEntries(projectRoot),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/jobs/latest") {
    sendJson(response, 200, getLatestJob(options.home));
    return;
  }

  if (method === "GET" && url.pathname === "/api/jobs") {
    sendJson(response, 200, getRecentJobs(options.home));
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, getProjects(options.home));
    return;
  }

  if (method === "POST" && url.pathname === "/api/admin/projects") {
    const parsed = parseAdminProjectRequest(await readJsonBody(request));
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }

    const projectPaths = resolveAdminProjectPaths(projectRoot, parsed.value.name, parsed.value.projectPaths);
    if (projectPaths.length === 0) {
      sendJson(response, 404, { error: `project directories not found: ${parsed.value.name}` });
      return;
    }

    try {
      sendJson(response, 201, addProject(options.home, {
        ...parsed.value,
        projectPaths,
        projectRoot,
      }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const projectLatestMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/latest$/);
  if (method === "GET" && projectLatestMatch) {
    sendJson(response, 200, getLatestJobForProjectName(options.home, decodeURIComponent(projectLatestMatch[1])));
    return;
  }

  const projectJobsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/jobs$/);
  if (method === "GET" && projectJobsMatch) {
    sendJson(response, 200, getRecentJobsForProjectName(options.home, decodeURIComponent(projectJobsMatch[1])));
    return;
  }

  const projectRunsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
  if (method === "POST" && projectRunsMatch) {
    const body = await readJsonBody(request);
    const worktreePath = textValue(body.worktreePath ?? body.path ?? body.projectPath) ?? undefined;
    const runDate = textValue(body.runDate ?? body.date ?? body.ref) ?? undefined;
    try {
      sendJson(response, 201, runProjectByName(options.home, {
        name: decodeURIComponent(projectRunsMatch[1]),
        projectRoot,
        worktreePath,
        runDate,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("프로젝트를 찾을 수 없습니다")) {
        sendJson(response, 404, { error: error.message });
        return;
      }
      if (error instanceof Error && (
        error.message.includes("등록된 worktree path가 아닙니다")
        || error.message.includes("project path는 project root 아래여야 합니다")
        || error.message.includes("ENOENT")
      )) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      throw error;
    }
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch) {
    const job = getJob(options.home, jobMatch[1]);
    if (!job) {
      sendJson(response, 404, { error: "job not found" });
      return;
    }

    sendJson(response, 200, job);
    return;
  }

  const logsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    const log = getJobLog(options.home, logsMatch[1]);
    if (log === null) {
      sendJson(response, 404, { error: "job not found" });
      return;
    }

    sendText(response, 200, log);
    return;
  }

  const rerunMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/rerun$/);
  if (method === "POST" && rerunMatch) {
    sendJson(response, 201, rerunJob(options.home, rerunMatch[1]));
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

/** JSON 응답을 보냅니다. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body, null, 2));
}

/** 일반 텍스트 응답을 보냅니다. */
function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

/** HTML 응답을 보냅니다. */
function sendHtml(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

/** JSON body를 작은 객체로 읽습니다. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  const value = JSON.parse(text) as unknown;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Admin 프로젝트 등록 body를 도메인 입력으로 변환합니다. */
function parseAdminProjectRequest(body: Record<string, unknown>): AdminProjectParseResult {
  const name = textValue(body.name);
  const projectPaths = projectPathList(body.paths ?? body.projectPaths ?? body.path ?? body.projectPath);
  const commands = commandList(body.commands);

  if (!name) {
    return { ok: false, error: "name is required" };
  }

  if (commands.length === 0) {
    return { ok: false, error: "commands must include at least one command" };
  }

  return {
    ok: true,
    value: {
      name,
      projectPaths: projectPaths.length > 0 ? projectPaths : null,
      commands,
    },
  };
}

/** 문자열 입력에서 공백을 정리하고 빈 값은 제거합니다. */
function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** API와 textarea 양쪽 입력을 command 배열로 정규화합니다. */
function commandList(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const command = textValue(item);
      return command ? [command] : [];
    });
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  return [];
}

/** 단일 path와 paths 배열/textarea 입력을 프로젝트 경로 배열로 정규화합니다. */
function projectPathList(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const path = textValue(item);
      return path ? [path] : [];
    });
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  return [];
}

/** 사용자에게 보여줄 경로에서 홈 디렉터리를 ~로 축약합니다. */
function displayPathForUser(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** project root 아래에서 등록 후보로 쓸 수 있는 디렉터리 목록을 만듭니다. */
export function listProjectRootEntries(projectRoot: string): readonly ProjectRootEntry[] {
  try {
    return readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => nestedDirectoryEntries(projectRoot, entry.name))
      .map((path) => ({
        path,
        projectName: projectNameFromDirectoryPath(path),
      }))
      .sort((left, right) => (
        left.projectName.localeCompare(right.projectName)
        || left.path.localeCompare(right.path)
      ))
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** 프로젝트명과 일치하는 기준 디렉터리 후보의 상대경로를 찾습니다. */
export function projectPathsForName(projectRoot: string, name: string): readonly string[] {
  return listProjectRootEntries(projectRoot)
    .filter((entry) => entry.projectName === name)
    .map((entry) => entry.path);
}

/** Admin 등록 요청에서 명시 경로가 없으면 프로젝트명으로 경로를 자동 탐지합니다. */
export function resolveAdminProjectPaths(
  projectRoot: string,
  name: string,
  explicitPaths: readonly string[] | null,
): readonly string[] {
  return explicitPaths && explicitPaths.length > 0 ? explicitPaths : projectPathsForName(projectRoot, name);
}

/** worktree 해시 폴더 아래의 실제 프로젝트 디렉터리를 우선 목록에 노출합니다. */
function nestedDirectoryEntries(projectRoot: string, topLevelName: string): readonly string[] {
  const topLevelPath = join(projectRoot, topLevelName);
  try {
    const children = directoryNames(topLevelPath);

    if (/^[0-9a-f]{4}$/i.test(topLevelName) && children.length > 0) {
      return children.flatMap((childName) => projectDirectoryCandidates(projectRoot, topLevelName, childName));
    }

    return [topLevelName, ...children.map((childName) => `${topLevelName}/${childName}`)];
  } catch {
    return [topLevelName];
  }
}

/** 디렉터리 안의 하위 디렉터리 이름만 정렬해서 반환합니다. */
function directoryNames(path: string): readonly string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** 해시 폴더 아래 프로젝트 segment를 기준으로 실제 등록 후보 경로를 만듭니다. */
function projectDirectoryCandidates(
  projectRoot: string,
  topLevelName: string,
  projectSegment: string,
): readonly string[] {
  const projectPath = join(projectRoot, topLevelName, projectSegment);
  const projectRelativePath = `${topLevelName}/${projectSegment}`;

  if (looksLikeProjectDirectory(projectPath)) {
    return [projectRelativePath];
  }

  try {
    const nestedProjectPaths = directoryNames(projectPath)
      .map((childName) => `${projectRelativePath}/${childName}`)
      .filter((path) => looksLikeProjectDirectory(join(projectRoot, path)));

    return nestedProjectPaths.length > 0 ? nestedProjectPaths : [projectRelativePath];
  } catch {
    return [projectRelativePath];
  }
}

/** 프로젝트로 실행할 가능성이 높은 디렉터리인지 대표 파일로 가볍게 판별합니다. */
function looksLikeProjectDirectory(path: string): boolean {
  return PROJECT_MARKER_FILES.some((marker) => existsSync(join(path, marker)));
}

/** 후보 경로에서 사용자에게 보여줄 프로젝트명을 추출합니다. */
function projectNameFromDirectoryPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length >= 2 && /^[0-9a-f]{4}$/i.test(segments[0])) {
    return segments[1];
  }

  if (segments.length >= 3) {
    return segments[segments.length - 2];
  }

  return basename(path);
}

/** 대시보드와 상세 페이지가 공유하는 기본 페이지 스타일입니다. */
function sharedPageCss(): string {
  return `
    @import url("https://cdn.jsdelivr.net/gh/wanteddev/wanted-sans@v1.0.1/packages/wanted-sans/fonts/webfonts/variable/split/WantedSansVariable.min.css");

    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      background: #f3f5f7;
      color: #161c26;
      font-family: "Wanted Sans Variable", "Wanted Sans", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: geometricPrecision;
      font-size: 16px;
      line-height: 1.55;
    }
    main {
      max-width: 1080px;
      margin: 0 auto;
      padding: 36px 24px 52px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }
    h1, h2, h3, p {
      margin-top: 0;
    }
    h1 {
      margin-bottom: 0;
      font-size: 36px;
      font-weight: 830;
      line-height: 1.12;
      letter-spacing: 0;
    }
    h2 {
      margin-bottom: 14px;
      font-size: 23px;
      font-weight: 780;
      line-height: 1.2;
    }
    h3 {
      font-size: 18px;
      font-weight: 760;
      line-height: 1.3;
    }
    section {
      margin-bottom: 24px;
      border: 1px solid #d9dee8;
      border-radius: 8px;
      background: white;
      padding: 22px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    button,
    a.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      border: 0;
      border-radius: 6px;
      background: #0f766e;
      color: white;
      padding: 0 13px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
    }
    button.secondary,
    a.button.secondary {
      border: 1px solid #cbd5e1;
      background: white;
      color: #1d2430;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .app-kicker {
      margin: 0 0 4px;
      color: #0f766e;
      font-size: 13px;
      font-weight: 850;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.2;
    }
    .status-success {
      background: #dcfce7;
      color: #166534;
    }
    .status-running {
      background: #dbeafe;
      color: #1d4ed8;
    }
    .status-failed {
      background: #fee2e2;
      color: #b91c1c;
    }
    .status-queued {
      background: #f1f5f9;
      color: #475569;
    }
    .demo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 8px;
      border-radius: 999px;
      background: #fff7ed;
      color: #9a3412;
      padding: 2px 7px;
      font-size: 12px;
      font-weight: 800;
      line-height: 1.2;
      vertical-align: middle;
    }
    @media (max-width: 760px) {
      main {
        padding: 24px 14px 40px;
      }
      header {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  `;
}

/** 서버 렌더링에서 상태 badge HTML을 만듭니다. */
function statusBadgeHtml(status: string): string {
  const statusText = status || "queued";
  const knownStatus = ["queued", "running", "success", "failed"].includes(statusText) ? statusText : "queued";
  return `<span class="status-badge status-${escapeHtmlText(knownStatus)}">${escapeHtmlText(statusText)}</span>`;
}

/** demo job이면 서버 렌더링용 demo badge를 반환합니다. */
function demoBadgeHtml(job: Job): string {
  return job.runDate.startsWith("demo-") ? '<span class="demo-badge">demo</span>' : "";
}

/** 서버 렌더링에서 날짜를 월일 시분 형태로 줄입니다. */
function formatCompactDateForUser(value: string): string {
  const text = String(value || "").replace(/^demo-/, "");
  const isoDate = /^\d{4}-/.test(text) ? new Date(text) : null;
  if (isoDate && !Number.isNaN(isoDate.getTime())) {
    return formatDatePartsForUser(isoDate.getMonth() + 1, isoDate.getDate(), isoDate.getHours(), isoDate.getMinutes());
  }

  const compact = text.match(/^(\d{4})-?(\d{2})-?(\d{2})T?(\d{2}):?(\d{2})/);
  if (compact) {
    return `${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}`;
  }

  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    return formatDatePartsForUser(date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes());
  }

  return text;
}

/** 날짜 구성요소를 월일 시분 문자열로 만듭니다. */
function formatDatePartsForUser(month: number, day: number, hour: number, minute: number): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** project root 아래 경로를 사용자에게 짧게 표시합니다. */
function displayProjectPathForUser(projectRoot: string, path: string): string {
  const projectRootLabel = displayPathForUser(projectRoot);
  if (path === projectRoot) {
    return projectRootLabel;
  }

  if (path.startsWith(`${projectRoot}/`)) {
    return `${projectRootLabel}/${path.slice(projectRoot.length + 1)}`;
  }

  return displayPathForUser(path);
}

/** 찾을 수 없는 HTML 문서를 반환합니다. */
function notFoundHtml(message: string): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini CI - Not found</title>
    <style>${sharedPageCss()}</style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="app-kicker">Mini CI</p>
          <h1>${escapeHtmlText(message)}</h1>
        </div>
        <a class="button" href="/">Dashboard</a>
      </header>
    </main>
  </body>
</html>`;
}

/** 단일 job 상세 HTML 문서를 반환합니다. */
function jobDetailHtml(projectRoot: string, job: Job, log: string): string {
  const logUrl = `/api/jobs/${encodeURIComponent(job.id)}/logs`;
  const jobUrl = `/jobs/${encodeURIComponent(job.id)}`;
  const rows = [
    ["Project", escapeHtmlText(job.projectName ?? job.projectId)],
    ["Status", statusBadgeHtml(job.status)],
    ["Worktree ID", escapeHtmlText(job.worktreeId)],
    ["Worktree path", escapeHtmlText(displayProjectPathForUser(projectRoot, job.worktreePath))],
    ["Run date", `${escapeHtmlText(formatCompactDateForUser(job.runDate))}${demoBadgeHtml(job)}`],
    ["Failed step", escapeHtmlText(job.failedStep ?? "-")],
    ["Exit code", escapeHtmlText(String(job.exitCode ?? "-"))],
    ["Created", escapeHtmlText(formatCompactDateForUser(job.createdAt))],
  ];

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini CI - ${escapeHtmlText(job.projectName ?? "Job")}</title>
    <style>
      ${sharedPageCss()}
      .detail-layout {
        display: grid;
        gap: 20px;
      }
      .detail-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .detail-summary {
        display: grid;
        grid-template-columns: 140px minmax(0, 1fr);
        gap: 10px 16px;
        margin: 0;
      }
      .detail-summary dt {
        color: #647084;
        font-weight: 800;
      }
      .detail-summary dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .console-panel {
        overflow: hidden;
        border-color: #111827;
        background: #0b1020;
        color: #e5edf6;
        padding: 0;
      }
      .console-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        border-bottom: 1px solid #1f2937;
        background: #111827;
        padding: 18px 20px;
      }
      .console-header h2 {
        margin-bottom: 4px;
        color: #f8fafc;
      }
      .console-context {
        margin: 0;
        color: #9ca3af;
        font-size: 14px;
        overflow-wrap: anywhere;
      }
      .console-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .console-action {
        min-height: 32px;
        border: 1px solid #334155;
        border-radius: 6px;
        background: #1f2937;
        color: #e5edf6;
        padding: 0 10px;
        font-size: 14px;
      }
      .console-output {
        overflow-x: auto;
        margin: 0;
        border-radius: 0;
        background: #0b1020;
        color: #d8dee9;
        padding: 20px;
        font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", ui-monospace, monospace;
        font-size: 13px;
        line-height: 1.65;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      @media (max-width: 760px) {
        .console-header {
          flex-direction: column;
        }
        .detail-summary {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="app-kicker">Mini CI</p>
          <h1>Run Detail</h1>
        </div>
        <div class="detail-actions">
          <a class="button secondary" href="/">Dashboard</a>
          <button id="rerun" type="button">Rerun</button>
        </div>
      </header>
      <div class="detail-layout">
        <section>
          <h2>Selected Run</h2>
          <dl class="detail-summary">
            ${rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("")}
          </dl>
        </section>
        <section class="console-panel">
          <div class="console-header">
            <div>
              <p class="app-kicker">Console</p>
              <h2>Console Log</h2>
              <p class="console-context">${escapeHtmlText(job.projectName ?? job.projectId)} / ${escapeHtmlText(job.worktreeId)} / ${escapeHtmlText(formatCompactDateForUser(job.runDate))}</p>
            </div>
            <div class="console-actions">
              <a class="console-action" href="${logUrl}" target="_blank" rel="noreferrer">Raw log</a>
              <button id="copy-log" class="console-action" type="button">Copy</button>
            </div>
          </div>
          <pre id="logs" class="console-output">${escapeHtmlText(log)}</pre>
        </section>
      </div>
    </main>
    <script>
      const jobId = ${JSON.stringify(job.id)};
      const rerunEl = document.getElementById("rerun");
      const copyLogEl = document.getElementById("copy-log");
      const logsEl = document.getElementById("logs");

      rerunEl.addEventListener("click", async () => {
        rerunEl.disabled = true;
        const response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/rerun", { method: "POST" });
        if (!response.ok) {
          alert(await response.text());
          rerunEl.disabled = false;
          return;
        }

        const job = await response.json();
        window.location.href = "/jobs/" + encodeURIComponent(job.id);
      });

      copyLogEl.addEventListener("click", async () => {
        const previousLabel = copyLogEl.textContent;
        try {
          await copyText(logsEl.textContent || "");
          copyLogEl.textContent = "Copied";
        } catch {
          alert("Copy failed. Select the console text and copy it manually.");
        } finally {
          setTimeout(() => {
            copyLogEl.textContent = previousLabel;
          }, 1200);
        }
      });

      async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return;
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();

        if (!copied) {
          throw new Error("copy failed");
        }
      }
    </script>
  </body>
</html>`;
}

/** 대시보드 단일 HTML 문서를 반환합니다. */
function dashboardHtml(projectRoot: string): string {
  const projectRootLabel = displayPathForUser(projectRoot);

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini CI Dashboard</title>
    <style>
      @import url("https://cdn.jsdelivr.net/gh/wanteddev/wanted-sans@v1.0.1/packages/wanted-sans/fonts/webfonts/variable/split/WantedSansVariable.min.css");

      body {
        margin: 0;
        background: #f3f5f7;
        color: #161c26;
        font-family: "Wanted Sans Variable", "Wanted Sans", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
        text-rendering: geometricPrecision;
        font-size: 16px;
        line-height: 1.55;
      }
      main {
        max-width: 1080px;
        margin: 0 auto;
        padding: 36px 24px 52px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 22px;
      }
      h1, h2, h3, h4, p {
        margin-top: 0;
      }
      h1 {
        margin-bottom: 0;
        font-size: 36px;
        font-weight: 830;
        line-height: 1.12;
        letter-spacing: 0;
      }
      h2 {
        margin-bottom: 14px;
        font-size: 23px;
        font-weight: 780;
        line-height: 1.2;
      }
      h3 {
        font-size: 18px;
        font-weight: 760;
        line-height: 1.3;
      }
      h4 {
        font-size: 15px;
        font-weight: 780;
        line-height: 1.3;
      }
      section {
        margin-bottom: 24px;
        border: 1px solid #d9dee8;
        border-radius: 8px;
        background: white;
        padding: 22px;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      }
      dl {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 8px 16px;
        margin: 0;
      }
      dt {
        color: #647084;
        font-weight: 700;
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      pre {
        overflow: auto;
        min-height: 180px;
        margin: 0;
        border-radius: 8px;
        background: #101828;
        color: #eef2f7;
        padding: 16px;
        font-size: 14px;
        line-height: 1.6;
      }
      input {
        min-height: 36px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 0 10px;
      }
      button, a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        border: 0;
        border-radius: 6px;
        background: #0f766e;
        color: white;
        padding: 0 13px;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
      }
      .app-kicker {
        margin: 0 0 4px;
        color: #0f766e;
        font-size: 13px;
        font-weight: 850;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .runs-toolbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
        border-bottom: 1px solid #edf1f5;
        padding-bottom: 16px;
      }
      .runs-toolbar p {
        margin: 6px 0 0;
        color: #647084;
      }
      .runs-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
        gap: 22px;
        align-items: start;
      }
      .history-list {
        min-width: 0;
      }
      .selected-run-panel {
        position: sticky;
        top: 20px;
        margin-bottom: 0;
        border: 1px solid #cfe1df;
        border-radius: 8px;
        background: #f8fcfb;
        padding: 18px;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.07);
      }
      .selected-run-panel h2 {
        margin-bottom: 12px;
        font-size: 20px;
      }
      .selected-run-panel dl {
        grid-template-columns: 104px minmax(0, 1fr);
        gap: 8px 12px;
        font-size: 14px;
      }
      .selected-run-panel dt {
        font-size: 13px;
        font-weight: 800;
      }
      .selected-run-panel .status-badge {
        padding: 3px 8px;
        font-size: 13px;
      }
      .status,
      .status-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 14px;
        font-weight: 700;
        line-height: 1.2;
      }
      .status-success {
        background: #dcfce7;
        color: #166534;
      }
      .status-running {
        background: #dbeafe;
        color: #1d4ed8;
      }
      .status-failed {
        background: #fee2e2;
        color: #b91c1c;
      }
      .status-queued {
        background: #f1f5f9;
        color: #475569;
      }
      .demo-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 8px;
        border-radius: 999px;
        background: #fff7ed;
        color: #9a3412;
        padding: 2px 7px;
        font-size: 12px;
        font-weight: 800;
        line-height: 1.2;
        vertical-align: middle;
      }
      ul {
        margin: 0;
        padding-left: 20px;
      }
      li + li {
        margin-top: 8px;
      }
      .project-list, .run-form {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .project-list {
        justify-content: flex-end;
        min-width: 260px;
      }
      .project-list button {
        border: 1px solid #d9dee8;
        background: #fbfcfe;
        color: #1d2430;
      }
      .project-list button[aria-pressed="true"] {
        border-color: #0f766e;
        background: #e6f4f1;
        color: #0b5f59;
      }
      .selected-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }
      .run-form input {
        flex: 1 1 190px;
      }
      .pending-action {
        border-color: #b7d8d3;
        background: #f7fcfb;
      }
      .pending-action[hidden] {
        display: none;
      }
      .pending-action p {
        margin: 8px 0 0;
        color: #647084;
      }
      .pending-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(260px, 0.72fr);
        gap: 18px;
        margin-top: 18px;
      }
      .pending-grid h3 {
        margin: 0 0 8px;
        color: #475569;
        font-size: 12px;
        font-weight: 850;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .pending-list,
      .pending-command-list {
        display: grid;
        gap: 6px;
        margin: 0;
        padding-left: 0;
        list-style: none;
      }
      .pending-list li,
      .pending-command-list li {
        margin-top: 0;
      }
      .pending-list code,
      .pending-command-list code {
        display: inline-block;
        max-width: 100%;
        border-radius: 4px;
        background: #eef2f7;
        color: #334155;
        padding: 2px 6px;
        overflow-wrap: anywhere;
      }
      .pending-command-list code {
        background: #e6f4f1;
        color: #0b5f59;
      }
      .pending-meta {
        display: grid;
        grid-template-columns: 92px minmax(0, 1fr);
        gap: 8px 12px;
        margin: 0;
      }
      .pending-meta dt {
        color: #647084;
        font-size: 13px;
        font-weight: 800;
      }
      .pending-meta dd {
        margin: 0;
      }
      .pending-warning {
        margin-top: 14px;
        border-radius: 6px;
        background: #fef3c7;
        color: #92400e;
        padding: 10px 12px;
        font-weight: 750;
      }
      .pending-warning[hidden] {
        display: none;
      }
      .pending-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }
      button.secondary,
      a.button.secondary {
        border: 1px solid #cbd5e1;
        background: white;
        color: #1d2430;
      }
      a.button[aria-disabled="true"] {
        pointer-events: none;
        opacity: 0.55;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .history-project + .history-project {
        margin-top: 24px;
      }
      .history-project h3 {
        margin: 0;
      }
      .project-header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        border-bottom: 1px solid #e4eaf1;
        padding: 22px 0 12px;
      }
      .project-meta {
        color: #647084;
        font-size: 13px;
        font-weight: 750;
      }
      .run-grid-head,
      .run-row {
        display: grid;
        grid-template-columns: minmax(170px, 1fr) 150px 72px;
        gap: 16px;
        align-items: center;
      }
      .run-grid-head {
        color: #647084;
        font-size: 12px;
        font-weight: 850;
        padding: 14px 0 8px;
        text-transform: uppercase;
      }
      .history-worktree {
        border-top: 1px solid #eef2f7;
        padding: 12px 0 4px;
      }
      .worktree-header {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr);
        gap: 14px;
        align-items: baseline;
        margin-bottom: 6px;
      }
      .worktree-id {
        color: #161c26;
        font-size: 15px;
        font-weight: 820;
      }
      .run-rows {
        display: grid;
        gap: 8px;
        margin-left: 110px;
        font-size: 15px;
        font-variant-numeric: tabular-nums;
      }
      .run-row {
        width: 100%;
        min-height: 48px;
        border: 1px solid #eef2f7;
        border-radius: 8px;
        background: #fbfcfe;
        color: #161c26;
        cursor: pointer;
        font: inherit;
        justify-content: stretch;
        padding: 0 12px;
        text-align: left;
      }
      .run-row:hover {
        border-color: #b7d8d3;
        background: #f7fcfb;
      }
      .run-row:focus-visible {
        outline: 3px solid rgba(15, 118, 110, 0.25);
        outline-offset: 2px;
      }
      .run-row:first-child {
        border-top: 1px solid #eef2f7;
      }
      .run-row.is-demo {
        background: #fffdf6;
      }
      .run-row.is-selected {
        border-color: #0f766e;
        background: #e6f4f1;
        box-shadow: inset 4px 0 0 #0f766e, 0 0 0 2px rgba(15, 118, 110, 0.12);
      }
      .run-date {
        color: #0b5f59;
        font-weight: 800;
      }
      .worktree-path {
        display: inline-block;
        color: #647084;
        font-size: 14px;
        overflow-wrap: anywhere;
      }
      @media (max-width: 760px) {
        main {
          padding: 24px 14px 40px;
        }
        header {
          align-items: flex-start;
          flex-direction: column;
        }
        .runs-toolbar {
          align-items: stretch;
          flex-direction: column;
        }
        .project-list {
          justify-content: flex-start;
          min-width: 0;
        }
        .runs-layout {
          grid-template-columns: 1fr;
        }
        .selected-run-panel {
          position: static;
          order: -1;
        }
        .pending-grid {
          grid-template-columns: 1fr;
        }
        .project-header {
          align-items: flex-start;
          flex-direction: column;
        }
        .run-grid-head,
        .run-row {
          grid-template-columns: minmax(130px, 1fr) 110px 50px;
          gap: 10px;
        }
        .worktree-header {
          grid-template-columns: 1fr;
          gap: 2px;
        }
        .run-rows {
          margin-left: 0;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="app-kicker">Mini CI</p>
          <h1>Dashboard</h1>
        </div>
        <a class="button" href="/admin">Admin</a>
      </header>
      <section>
        <div class="runs-toolbar">
          <div>
            <h2>Runs</h2>
            <p>Project, worktree, date, status, and exit code.</p>
          </div>
          <div id="projects" class="project-list"></div>
        </div>
        <div class="runs-layout">
          <div id="history" class="history-list"></div>
          <aside class="selected-run-panel" aria-live="polite">
          <h2>Selected Run</h2>
          <dl id="job"></dl>
          <div class="selected-actions">
            <a id="job-detail" class="button secondary" aria-disabled="true">Open run detail</a>
            <button id="rerun" type="button">Rerun</button>
          </div>
          </aside>
        </div>
      </section>
      <section>
        <h2>Manual Run</h2>
        <form id="run-form" class="run-form">
          <input id="run-worktree-path" name="worktreePath" placeholder="worktree path, e.g. wt-001/app" />
          <input id="run-date" name="runDate" placeholder="run date, e.g. 05-11 14:30 or 20260511143000" />
          <button type="submit">Run selected project</button>
        </form>
      </section>
      <section id="pending-action" class="pending-action" hidden>
        <h2 id="pending-title">Confirm run</h2>
        <p id="pending-summary"></p>
        <div class="pending-grid">
          <div>
            <h3>Execution paths</h3>
            <ul id="pending-paths" class="pending-list"></ul>
          </div>
          <div>
            <h3>Commands</h3>
            <ul id="pending-commands" class="pending-command-list"></ul>
          </div>
        </div>
        <dl id="pending-meta" class="pending-meta"></dl>
        <p id="pending-warning" class="pending-warning" hidden></p>
        <div class="pending-actions">
          <button id="confirm-run" type="button">Confirm run</button>
          <button id="cancel-run" class="secondary" type="button">Cancel</button>
        </div>
      </section>
    </main>
    <script>
      const jobEl = document.getElementById("job");
      const jobDetailEl = document.getElementById("job-detail");
      const rerunEl = document.getElementById("rerun");
      const historyEl = document.getElementById("history");
      const projectsEl = document.getElementById("projects");
      const runFormEl = document.getElementById("run-form");
      const runWorktreePathEl = document.getElementById("run-worktree-path");
      const runDateEl = document.getElementById("run-date");
      const pendingActionEl = document.getElementById("pending-action");
      const pendingTitleEl = document.getElementById("pending-title");
      const pendingSummaryEl = document.getElementById("pending-summary");
      const pendingPathsEl = document.getElementById("pending-paths");
      const pendingCommandsEl = document.getElementById("pending-commands");
      const pendingMetaEl = document.getElementById("pending-meta");
      const pendingWarningEl = document.getElementById("pending-warning");
      const confirmRunEl = document.getElementById("confirm-run");
      const cancelRunEl = document.getElementById("cancel-run");
      const projectRootPath = ${JSON.stringify(projectRoot)};
      const projectRootLabel = ${JSON.stringify(projectRootLabel)};
      let currentJob = null;
      let selectedJobId = null;
      let selectedProjectName = "all";
      let projectConfigs = [];
      let pendingAction = null;

      async function load(options = {}) {
        await loadProjects();
        await loadHistory();

        const selectedJob = options.keepSelectedJob && selectedJobId
          ? await loadJobById(selectedJobId)
          : null;
        const job = selectedJob || await loadLatestJob();

        if (!job) {
          currentJob = null;
          selectedJobId = null;
          jobEl.innerHTML = "<dt>상태</dt><dd>아직 job이 없습니다.</dd>";
          jobDetailEl.removeAttribute("href");
          jobDetailEl.setAttribute("aria-disabled", "true");
          rerunEl.disabled = true;
          return;
        }

        await selectJob(job);
      }

      async function loadLatestJob() {
        const latest = await fetch(latestUrl()).then((response) => response.json());
        return latest && latest.id ? latest : null;
      }

      async function loadJobById(jobId) {
        const response = await fetch("/api/jobs/" + encodeURIComponent(jobId));
        if (!response.ok) {
          return null;
        }

        const job = await response.json();
        return job && job.id ? job : null;
      }

      async function selectJob(job) {
        currentJob = job;
        selectedJobId = job.id;
        renderJob(job);
        markSelectedHistoryJob(job.id);
      }

      async function loadHistory() {
        const jobs = await fetch(jobsUrl()).then((response) => response.json());
        historyEl.innerHTML = renderHistory(jobs);
      }

      function renderHistory(jobs) {
        if (!jobs.length) {
          return "<p>No jobs yet.</p>";
        }

        return groupJobs(jobs).map((projectGroup) => {
          return "<div class='history-project'>" +
            "<div class='project-header'>" +
            "<h3>" + escapeHtml(projectGroup.name) + "</h3>" +
            "<span class='project-meta'>" +
            escapeHtml(projectGroup.worktrees.length) + " worktrees / " +
            escapeHtml(projectGroup.runCount) + " runs" +
            "</span>" +
            "</div>" +
            "<div class='run-grid-head'><span>Date</span><span>Status</span><span>Exit</span></div>" +
            projectGroup.worktrees.map(renderWorktreeHistory).join("") +
            "</div>";
        }).join("");
      }

      function renderWorktreeHistory(worktreeGroup) {
        return "<div class='history-worktree'>" +
          "<div class='worktree-header'>" +
          "<div class='worktree-id'>" + escapeHtml(worktreeGroup.worktreeId) + "</div>" +
          "<span class='worktree-path'>" + escapeHtml(displayProjectPath(worktreeGroup.worktreePath)) + "</span>" +
          "</div>" +
          "<div class='run-rows'>" +
          worktreeGroup.jobs.map((job) => {
            const rowClass = ["run-row"]
              .concat(isDemoJob(job) ? ["is-demo"] : [])
              .concat(job.id === selectedJobId ? ["is-selected"] : [])
              .join(" ");
            const currentAttribute = job.id === selectedJobId ? " aria-current='true'" : "";
            return "<button class='" + rowClass + "' type='button' title='Select run' data-job-id='" + escapeAttribute(job.id) + "'" + currentAttribute + ">" +
              "<span class='run-date'>" + escapeHtml(formatCompactDate(job.runDate)) + demoBadge(job) + "</span>" +
              "<div>" + statusBadge(job.status) + "</div>" +
              "<div>" + escapeHtml(job.exitCode ?? "-") + "</div>" +
              "</button>";
          }).join("") +
          "</div></div>";
      }

      function groupJobs(jobs) {
        const projects = [];
        const projectByName = new Map();
        for (const job of jobs) {
          const projectName = job.projectName || job.projectId;
          if (!projectByName.has(projectName)) {
            const projectGroup = {
              name: projectName,
              runCount: 0,
              worktrees: [],
              worktreeById: new Map(),
            };
            projectByName.set(projectName, projectGroup);
            projects.push(projectGroup);
          }

          const projectGroup = projectByName.get(projectName);
          const worktreeId = job.worktreeId || "unknown";
          if (!projectGroup.worktreeById.has(worktreeId)) {
            const worktreeGroup = {
              worktreeId,
              worktreePath: job.worktreePath || "-",
              jobs: [],
            };
            projectGroup.worktreeById.set(worktreeId, worktreeGroup);
            projectGroup.worktrees.push(worktreeGroup);
          }

          projectGroup.worktreeById.get(worktreeId).jobs.push(job);
          projectGroup.runCount += 1;
        }

        return projects;
      }

      async function loadProjects() {
        const projects = await fetch("/api/projects").then((response) => response.json());
        projectConfigs = Array.isArray(projects) ? projects : [];
        projectsEl.replaceChildren(projectButton("all", "All projects"));
        for (const project of projectConfigs) {
          projectsEl.append(projectButton(project.name, project.name));
        }
      }

      function renderJob(job) {
        rerunEl.disabled = false;
        jobDetailEl.href = "/jobs/" + encodeURIComponent(job.id);
        jobDetailEl.removeAttribute("aria-disabled");
        jobEl.innerHTML = [
          ["프로젝트", escapeHtml(job.projectName || job.projectId)],
          ["상태", statusBadge(job.status)],
          ["Worktree ID", escapeHtml(job.worktreeId)],
          ["Worktree path", escapeHtml(displayProjectPath(job.worktreePath))],
          ["Run date", escapeHtml(formatCompactDate(job.runDate)) + demoBadge(job)],
          ["실패 step", escapeHtml(job.failedStep || "-")],
          ["exit code", escapeHtml(job.exitCode ?? "-")],
          ["생성", escapeHtml(formatCompactDate(job.createdAt))],
        ].map(([key, value]) => "<dt>" + key + "</dt><dd>" + value + "</dd>").join("");
      }

      function projectButton(name, label) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.setAttribute("aria-pressed", String(selectedProjectName === name));
        button.addEventListener("click", async () => {
          selectedProjectName = name;
          selectedJobId = null;
          hidePendingAction();
          await load();
        });
        return button;
      }

      function latestUrl() {
        if (selectedProjectName === "all") {
          return "/api/jobs/latest";
        }

        return "/api/projects/" + encodeURIComponent(selectedProjectName) + "/latest";
      }

      function jobsUrl() {
        if (selectedProjectName === "all") {
          return "/api/jobs";
        }

        return "/api/projects/" + encodeURIComponent(selectedProjectName) + "/jobs";
      }

      historyEl.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-job-id]");
        if (!button) return;

        const job = await loadJobById(button.dataset.jobId);
        if (job) {
          hidePendingAction();
          await selectJob(job);
        }
      });

      rerunEl.addEventListener("click", async () => {
        if (!currentJob) return;
        const project = projectConfigByName(currentJob.projectName || currentJob.projectId);
        if (!project) {
          alert("Project settings are not loaded yet.");
          return;
        }

        showPendingAction({
          kind: "rerun",
          project,
          job: currentJob,
          worktreePath: currentJob.worktreePath,
          runDate: currentJob.runDate,
        });
      });

      runFormEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (selectedProjectName === "all") {
          alert("Select one project");
          return;
        }

        const project = projectConfigByName(selectedProjectName);
        if (!project) {
          alert("Project settings are not loaded yet.");
          return;
        }

        showPendingAction({
          kind: "manual",
          project,
          worktreePath: runWorktreePathEl.value.trim(),
          runDate: runDateEl.value.trim(),
        });
      });

      confirmRunEl.addEventListener("click", async () => {
        if (!pendingAction) return;

        confirmRunEl.disabled = true;
        const response = pendingAction.kind === "rerun"
          ? await fetch("/api/jobs/" + encodeURIComponent(pendingAction.job.id) + "/rerun", { method: "POST" })
          : await fetch("/api/projects/" + encodeURIComponent(pendingAction.project.name) + "/runs", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                worktreePath: pendingAction.worktreePath || undefined,
                runDate: pendingAction.runDate || undefined,
              }),
            });

        if (!response.ok) {
          alert(await response.text());
          confirmRunEl.disabled = false;
          return;
        }

        if (pendingAction.kind === "manual") {
          runWorktreePathEl.value = "";
          runDateEl.value = "";
        }

        hidePendingAction();
        selectedJobId = null;
        await load();
      });

      cancelRunEl.addEventListener("click", hidePendingAction);

      function showPendingAction(action) {
        pendingAction = action;
        const preview = runPreview(action);
        const projectName = action.project.name;
        pendingTitleEl.textContent = action.kind === "rerun" ? "Confirm rerun" : "Confirm manual run";
        pendingSummaryEl.textContent = action.kind === "rerun"
          ? "Rerun " + projectName + " with the same worktree and run date."
          : "Start " + projectName + " after confirming the execution target.";
        pendingPathsEl.innerHTML = preview.paths.map((path) => (
          "<li><code>" + escapeHtml(displayProjectPath(path)) + "</code></li>"
        )).join("");
        pendingCommandsEl.innerHTML = action.project.commands.map((command) => (
          "<li><code>" + escapeHtml(command) + "</code></li>"
        )).join("");
        pendingMetaEl.innerHTML = [
          ["Project", escapeHtml(projectName)],
          ["Worktree", escapeHtml(preview.worktreeLabel)],
          ["Run date", escapeHtml(action.runDate || "auto")],
        ].map(([key, value]) => "<dt>" + key + "</dt><dd>" + value + "</dd>").join("");

        pendingWarningEl.hidden = !preview.warning;
        pendingWarningEl.textContent = preview.warning || "";
        confirmRunEl.disabled = Boolean(preview.warning);
        pendingActionEl.hidden = false;
      }

      function hidePendingAction() {
        pendingAction = null;
        pendingActionEl.hidden = true;
        confirmRunEl.disabled = false;
      }

      function runPreview(action) {
        if (action.kind === "rerun") {
          return {
            paths: action.worktreePath === "all" ? action.project.projectPaths : [action.worktreePath],
            warning: "",
            worktreeLabel: action.worktreePath === "all" ? "all registered worktrees" : displayProjectPath(action.worktreePath),
          };
        }

        const requestedPath = action.worktreePath;
        if (requestedPath) {
          const registeredPath = registeredProjectPath(action.project, requestedPath);
          if (!registeredPath) {
            return {
              paths: [requestedPath],
              warning: "This worktree path is not registered for " + action.project.name + ".",
              worktreeLabel: requestedPath,
            };
          }

          return {
            paths: [registeredPath],
            warning: "",
            worktreeLabel: displayProjectPath(registeredPath),
          };
        }

        if (action.project.projectPaths.length === 1) {
          return {
            paths: action.project.projectPaths,
            warning: "",
            worktreeLabel: displayProjectPath(action.project.projectPaths[0]),
          };
        }

        return {
          paths: action.project.projectPaths,
          warning: "",
          worktreeLabel: "all registered worktrees",
        };
      }

      function registeredProjectPath(project, requestedPath) {
        const normalizedRequest = normalizeProjectPath(requestedPath);
        return project.projectPaths.find((path) => normalizeProjectPath(path) === normalizedRequest) || null;
      }

      function normalizeProjectPath(path) {
        const value = String(path);
        if (value.startsWith(projectRootPath + "/")) {
          return value.slice(projectRootPath.length + 1);
        }

        return value;
      }

      function projectConfigByName(name) {
        return projectConfigs.find((project) => project.name === name) || null;
      }

      function markSelectedHistoryJob(jobId) {
        for (const button of historyEl.querySelectorAll("button[data-job-id]")) {
          const selected = Boolean(jobId) && button.dataset.jobId === jobId;
          button.classList.toggle("is-selected", selected);

          if (selected) {
            button.setAttribute("aria-current", "true");
          } else {
            button.removeAttribute("aria-current");
          }
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function escapeAttribute(value) {
        return escapeHtml(value).replaceAll(String.fromCharCode(96), "&#96;");
      }

      function displayProjectPath(path) {
        const value = String(path);
        if (value === projectRootPath) {
          return projectRootLabel;
        }

        if (value.startsWith(projectRootPath + "/")) {
          return projectRootLabel + "/" + value.slice(projectRootPath.length + 1);
        }

        return value;
      }

      function statusBadge(status) {
        const statusText = String(status || "queued");
        const knownStatus = ["queued", "running", "success", "failed"].includes(statusText)
          ? statusText
          : "queued";
        return '<span class="status-badge status-' + escapeAttribute(knownStatus) + '">' +
          escapeHtml(statusText) +
          "</span>";
      }

      function demoBadge(job) {
        return isDemoJob(job) ? '<span class="demo-badge">demo</span>' : "";
      }

      function isDemoJob(job) {
        return String(job.runDate || "").startsWith("demo-");
      }

      function formatCompactDate(value) {
        const text = String(value || "").replace(/^demo-/, "");
        if (/^\\d{4}-/.test(text)) {
          const date = new Date(text);
          if (!Number.isNaN(date.getTime())) {
            return formatDateParts(date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes());
          }
        }

        const compact = text.match(/^(\\d{4})-?(\\d{2})-?(\\d{2})T?(\\d{2}):?(\\d{2})/);
        if (compact) {
          const month = compact[2];
          const day = compact[3];
          const hour = compact[4];
          const minute = compact[5];
          return month + "-" + day + " " + hour + ":" + minute;
        }

        const date = new Date(text);
        if (!Number.isNaN(date.getTime())) {
          return formatDateParts(date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes());
        }

        return text;
      }

      function formatDateParts(month, day, hour, minute) {
        return String(month).padStart(2, "0") + "-" +
          String(day).padStart(2, "0") + " " +
          String(hour).padStart(2, "0") + ":" +
          String(minute).padStart(2, "0");
      }

      load();
      setInterval(() => load({ keepSelectedJob: true }), 3000);
    </script>
  </body>
</html>`;
}

/** 프로젝트 설정을 관리하는 admin HTML 문서를 반환합니다. */
function adminHtml(projectRoot: string): string {
  const escapedProjectRoot = escapeHtmlText(displayPathForUser(projectRoot));

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini CI Admin</title>
    <style>
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: #f4f6f8;
        color: #1d2430;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 15px;
        line-height: 1.5;
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      h1,
      h2,
      h3,
      p {
        margin: 0;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }
      .eyebrow {
        color: #0f766e;
        font-size: 0.76rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin-top: 2px;
        font-size: 1.8rem;
        line-height: 1.15;
      }
      h2 {
        font-size: 1.08rem;
        line-height: 1.25;
      }
      h3 {
        margin-top: 18px;
        font-size: 0.95rem;
      }
      .admin-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 0.72fr);
        gap: 16px;
        align-items: start;
      }
      .panel {
        border: 1px solid #d9dee8;
        border-radius: 8px;
        background: white;
        padding: 18px;
        box-shadow: 0 1px 2px rgb(16 24 40 / 0.04);
      }
      .panel-wide {
        grid-column: 1;
      }
      .side-stack {
        display: grid;
        gap: 16px;
      }
      .panel-header {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
      }
      .panel-header p {
        margin-top: 4px;
        color: #647084;
      }
      .step {
        display: inline-flex;
        width: 26px;
        height: 26px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: #e6f4f1;
        color: #0b5f59;
        font-weight: 800;
      }
      label {
        display: grid;
        gap: 6px;
        margin-bottom: 14px;
        font-weight: 700;
      }
      .field-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .optional {
        color: #647084;
        font-size: 0.78rem;
        font-weight: 600;
      }
      input,
      textarea {
        width: 100%;
        min-height: 38px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 0 10px;
        font: inherit;
        color: #1d2430;
        outline: none;
      }
      input:focus,
      textarea:focus {
        border-color: #0f766e;
        box-shadow: 0 0 0 3px #d7f1ed;
      }
      ::placeholder {
        color: #98a2b3;
      }
      textarea {
        min-height: 104px;
        padding: 10px;
        resize: vertical;
      }
      button, a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        border: 0;
        border-radius: 6px;
        background: #0f766e;
        color: white;
        padding: 0 13px;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
      }
      a.secondary,
      button.secondary {
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #1d2430;
      }
      pre {
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        border-radius: 8px;
        background: #101828;
        color: #eef2f7;
        padding: 12px;
        font-size: 0.86rem;
        line-height: 1.45;
      }
      code {
        border-radius: 4px;
        background: #eef2f7;
        color: #334155;
        padding: 0.1rem 0.25rem;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 0.92em;
      }
      .hint {
        margin-top: -6px;
        margin-bottom: 14px;
        color: #647084;
        font-size: 0.9rem;
      }
      .base-path {
        margin-bottom: 16px;
        border-radius: 6px;
        background: #f8fafc;
        color: #475569;
        padding: 10px 12px;
      }
      .worktree-browser {
        margin-bottom: 16px;
      }
      .worktree-browser .field-label {
        margin-bottom: 8px;
      }
      .small-button {
        min-height: 28px;
        padding: 0 10px;
        font-size: 0.78rem;
      }
      .worktree-list {
        display: grid;
        gap: 10px;
        padding-left: 0;
        list-style: none;
      }
      .worktree-list li {
        margin-top: 0;
      }
      .project-candidate {
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        background: #fbfcfe;
        padding: 10px;
      }
      .project-candidate.is-saved {
        border-color: #b7d8d3;
        background: #f7fcfb;
      }
      .worktree-list button {
        display: grid;
        gap: 7px;
        justify-items: start;
        min-height: 30px;
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #1d2430;
        padding: 6px 10px;
        text-align: left;
      }
      .project-candidate.is-selected button {
        border-color: #0f766e;
        box-shadow: 0 0 0 3px #d7f1ed;
      }
      .project-candidate.is-dirty button {
        border-color: #d97706;
      }
      .candidate-top {
        display: flex;
        width: 100%;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .candidate-badges {
        display: inline-flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
      }
      .candidate-badge,
      .candidate-change {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 7px;
        font-size: 0.7rem;
        font-weight: 850;
        line-height: 1.2;
      }
      .candidate-badge-saved {
        background: #dff4ef;
        color: #0b5f59;
      }
      .candidate-badge-new {
        background: #eef2f7;
        color: #475569;
      }
      .candidate-change {
        display: none;
        background: #fef3c7;
        color: #92400e;
      }
      .project-candidate.is-dirty .candidate-change {
        display: inline-flex;
      }
      .directory-name {
        font-weight: 800;
      }
      .directory-path {
        color: #647084;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 0.76rem;
      }
      .candidate-config {
        display: grid;
        gap: 8px;
        width: 100%;
        border-top: 1px solid #e2e8f0;
        padding-top: 8px;
      }
      .candidate-config span {
        display: block;
      }
      .candidate-config strong {
        display: block;
        margin-bottom: 4px;
        color: #475569;
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .form-state {
        margin: -4px 0 14px;
        border-radius: 6px;
        background: #f8fafc;
        color: #647084;
        padding: 9px 10px;
        font-size: 0.86rem;
        font-weight: 700;
      }
      .form-state.is-saved {
        background: #e6f4f1;
        color: #0b5f59;
      }
      .form-state.is-dirty {
        background: #fef3c7;
        color: #92400e;
      }
      .form-state.is-new {
        background: #eef2f7;
        color: #475569;
      }
      .client-api {
        margin-top: 14px;
      }
      .client-api h3 {
        margin: 0 0 8px;
        color: #0f766e;
        font-size: 0.95rem;
        font-weight: 800;
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
      li + li {
        margin-top: 8px;
      }
      .empty-state {
        border: 1px dashed #cbd5e1;
        border-radius: 8px;
        background: #f8fafc;
        color: #647084;
        padding: 14px;
      }
      .project-path-list {
        display: grid;
        gap: 4px;
        margin-top: 0;
        padding-left: 0;
        list-style: none;
      }
      .project-path-list li {
        margin-top: 0;
      }
      .project-path-list code {
        display: inline-block;
        max-width: 100%;
        background: #f1f5f9;
        overflow-wrap: anywhere;
      }
      .command-list {
        display: grid;
        gap: 4px;
        margin: 0;
        padding-left: 0;
        list-style: none;
      }
      .command-list li {
        margin-top: 0;
      }
      .command-list code {
        display: inline-block;
        max-width: 100%;
        background: #eef6f5;
        color: #0b5f59;
        overflow-wrap: anywhere;
      }
      @media (max-width: 840px) {
        main {
          padding: 24px 16px 40px;
        }
        .admin-grid {
          grid-template-columns: 1fr;
        }
        .panel-wide {
          grid-column: auto;
        }
        .topbar {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="topbar">
        <div>
          <p class="eyebrow">Settings</p>
          <h1>Mini CI Admin</h1>
        </div>
        <a class="secondary" href="/">Dashboard</a>
      </header>
      <div class="admin-grid">
        <section class="panel panel-wide">
          <div class="panel-header">
            <span class="step">1</span>
            <div>
              <h2>Register project</h2>
              <p>Choose an existing directory under the base path.</p>
            </div>
          </div>
          <p class="base-path">Codex worktree base: <code>${escapedProjectRoot}</code></p>
          <div class="worktree-browser">
            <div class="field-label">
              <strong>Available directories</strong>
              <button id="refresh-worktrees" class="secondary small-button" type="button">Refresh</button>
            </div>
            <ul id="worktree-list" class="worktree-list">
              <li>Loading...</li>
            </ul>
          </div>
          <label>
            Project name
            <input id="project-name" autocomplete="off" placeholder="app" />
          </label>
          <p class="hint">Click a candidate or enter a project name. Matching directories are discovered automatically.</p>
          <label>
            <span class="field-label">
              Commands
              <span class="optional">one per line</span>
            </span>
            <textarea id="project-commands" autocomplete="off" placeholder="npm test"></textarea>
          </label>
          <p id="form-state" class="form-state">No project selected.</p>
          <button id="save-project" type="button">Save project</button>
          <div class="client-api">
            <h3>Client process API calls</h3>
            <p class="hint">WORKTREE_PATH selects the worktree. RUN_DATE becomes the date row on the dashboard.</p>
            <pre id="curl-example"></pre>
          </div>
        </section>
        <div class="side-stack">
          <section class="panel">
            <h2>Result</h2>
            <pre id="result">Waiting for an action.</pre>
          </section>
        </div>
      </div>
    </main>
    <script>
      const projectNameEl = document.getElementById("project-name");
      const projectCommandsEl = document.getElementById("project-commands");
      const formStateEl = document.getElementById("form-state");
      const curlExampleEl = document.getElementById("curl-example");
      const worktreeListEl = document.getElementById("worktree-list");
      const resultEl = document.getElementById("result");
      const projectRootPath = ${JSON.stringify(projectRoot)};
      const projectRootLabel = ${JSON.stringify(displayPathForUser(projectRoot))};
      let savedProjects = [];
      let directoryGroups = [];

      document.getElementById("save-project").addEventListener("click", async () => {
        const name = projectNameEl.value.trim();
        const commands = commandValues();
        if (!name || commands.length === 0) {
          setResult("Choose or enter a project name, then add at least one command.");
          return;
        }

        const response = await saveProject({ name, commands });
        await showResult(response);
        if (response.ok) {
          await loadProjects();
          await loadProjectRoot();
          loadProjectIntoForm(name);
        }
      });

      projectNameEl.addEventListener("input", () => {
        selectCandidateByName(projectNameEl.value.trim());
        refreshFormState();
        updateCurlExample();
      });
      projectCommandsEl.addEventListener("input", () => {
        refreshFormState();
        updateCurlExample();
      });

      document.getElementById("refresh-worktrees").addEventListener("click", loadProjectRoot);

      async function showResult(response) {
        const text = await response.text();
        setResult(text);
      }

      function setResult(text) {
        resultEl.textContent = text;
      }

      function updateCurlExample() {
        const name = projectNameEl.value.trim();
        const commands = commandValues();
        if (!name || commands.length === 0) {
          curlExampleEl.textContent = "Choose or enter a project name and commands to generate client API calls.";
          return;
        }

        const registerBody = {
          name,
          commands,
        };
        const commandsJson = JSON.stringify(registerBody.commands);
        const projectNameToken = "$" + "{PROJECT_NAME}";
        const worktreeIdToken = "$" + "{WORKTREE_ID}";
        const worktreePathToken = "$" + "{WORKTREE_PATH}";
        const commandsToken = "$" + "{COMMANDS}";
        const runDateToken = "$" + "{RUN_DATE}";
        curlExampleEl.textContent = 'PROJECT_NAME="' + shellDoubleQuoteValue(name) + '"\\n' +
          'WORKTREE_ID="<worktree-id>"\\n' +
          'WORKTREE_PATH="' + worktreeIdToken + "/" + projectNameToken + '"\\n' +
          'RUN_DATE="$(date +%Y%m%d%H%M%S)"\\n' +
          "COMMANDS=" + shellSingleQuoteValue(commandsJson) + "\\n\\n" +
          "# Refresh " + name + " for the selected worktree\\n" +
          'curl -X POST "' + window.location.origin + '/api/admin/projects" \\\\\\n' +
          '  -H "Content-Type: application/json" \\\\\\n' +
          '  -d "{\\\\"name\\\\":\\\\"' + projectNameToken + '\\\\",\\\\"paths\\\\":[\\\\"' + worktreePathToken + '\\\\"],\\\\"commands\\\\":' + commandsToken + '}"\\n\\n' +
          "# Start a " + name + " run for " + worktreePathToken + "\\n" +
          'curl -X POST "' + window.location.origin + '/api/projects/' + projectNameToken + '/runs" \\\\\\n' +
          '  -H "Content-Type: application/json" \\\\\\n' +
          '  -d "{\\\\"worktreePath\\\\":\\\\"' + worktreePathToken + '\\\\",\\\\"runDate\\\\":\\\\"' + runDateToken + '\\\\"}"';
      }

      function shellDoubleQuoteValue(value) {
        return String(value)
          .replaceAll("\\\\", "\\\\\\\\")
          .replaceAll('"', '\\\\"')
          .replaceAll("$", "\\\\$")
          .replaceAll(String.fromCharCode(96), "\\\\" + String.fromCharCode(96));
      }

      function shellSingleQuoteValue(value) {
        return "'" + String(value).replaceAll("'", "'\\\\''") + "'";
      }

      function commandValues() {
        return projectCommandsEl.value
          .split("\\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      }

      async function saveProject(body) {
        return fetch("/api/admin/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      }

      async function loadProjectRoot() {
        await loadProjects();
        const response = await fetch("/api/admin/project-root");
        if (!response.ok) {
          worktreeListEl.innerHTML = "<li>Cannot load directories</li>";
          return;
        }

        const info = await response.json();
        worktreeListEl.replaceChildren();
        const entries = Array.isArray(info.entries) ? info.entries : [];
        if (entries.length === 0 && savedProjects.length === 0) {
          const empty = document.createElement("li");
          empty.textContent = "No directories found";
          worktreeListEl.append(empty);
          refreshFormState();
          return;
        }

        directoryGroups = groupEntriesByProject(entries);
        for (const group of directoryGroups) {
          const savedProject = savedProjectByName(group.projectName);
          const item = document.createElement("li");
          const button = document.createElement("button");
          const top = document.createElement("span");
          const name = document.createElement("span");
          const path = document.createElement("span");
          const badges = document.createElement("span");
          const badge = document.createElement("span");
          const dirtyBadge = document.createElement("span");
          item.className = "project-candidate";
          item.dataset.projectName = group.projectName;
          if (savedProject) {
            item.classList.add("is-saved");
          }
          button.type = "button";
          top.className = "candidate-top";
          name.className = "directory-name";
          name.textContent = group.projectName;
          badges.className = "candidate-badges";
          badge.className = "candidate-badge " + (savedProject ? "candidate-badge-saved" : "candidate-badge-new");
          badge.textContent = savedProject ? "saved" : "new";
          dirtyBadge.className = "candidate-change";
          dirtyBadge.textContent = "unsaved changes";
          badges.append(badge, dirtyBadge);
          top.append(name, badges);
          path.className = "directory-path";
          path.textContent = group.entries.length > 0
            ? group.entries.map((entry) => entry.path).join(", ")
            : "No matching directory under the base path.";
          button.append(top, path, renderCandidateConfig(savedProject));
          button.addEventListener("click", () => {
            loadProjectIntoForm(group.projectName);
          });
          item.append(button);
          worktreeListEl.append(item);
        }
        selectCandidateByName(projectNameEl.value.trim());
        refreshFormState();
      }

      function renderCandidateConfig(project) {
        const config = document.createElement("span");
        config.className = "candidate-config";
        if (!project) {
          config.textContent = "No saved settings yet.";
          return config;
        }

        const paths = Array.isArray(project.projectPaths) ? project.projectPaths : [];
        const commands = Array.isArray(project.commands) ? project.commands : [];
        config.append(
          labeledInlineList("Stored directories", paths.map(displayProjectPath), "project-path-list"),
          labeledInlineList("Stored commands", commands, "command-list"),
        );
        return config;
      }

      function labeledInlineList(label, values, className) {
        const wrapper = document.createElement("span");
        const title = document.createElement("strong");
        const list = document.createElement("ul");
        title.textContent = label;
        list.className = className;
        for (const value of values) {
          const item = document.createElement("li");
          const code = document.createElement("code");
          code.textContent = value;
          item.append(code);
          list.append(item);
        }
        wrapper.append(title, list);
        return wrapper;
      }

      function clearSelectedCandidate() {
        for (const candidate of worktreeListEl.querySelectorAll(".project-candidate")) {
          candidate.classList.remove("is-selected", "is-dirty");
        }
      }

      function selectCandidateByName(projectName) {
        clearSelectedCandidate();
        for (const candidate of worktreeListEl.querySelectorAll(".project-candidate")) {
          if (candidate.dataset.projectName === projectName) {
            candidate.classList.add("is-selected");
          }
        }
      }

      function groupEntriesByProject(entries) {
        const groups = new Map();
        for (const entry of entries) {
          const projectName = entry.projectName || "unknown";
          groups.set(projectName, [...(groups.get(projectName) || []), entry]);
        }

        for (const project of savedProjects) {
          if (!groups.has(project.name)) {
            groups.set(project.name, []);
          }
        }

        return Array.from(groups.entries()).map(([projectName, projectEntries]) => ({
          projectName,
          entries: projectEntries,
        })).sort((left, right) => left.projectName.localeCompare(right.projectName));
      }

      async function loadProjects() {
        const projects = await fetch("/api/projects").then((response) => response.json());
        savedProjects = Array.isArray(projects) ? projects : [];
      }

      function loadProjectIntoForm(projectName) {
        const savedProject = savedProjectByName(projectName);
        projectNameEl.value = projectName;
        if (savedProject) {
          projectCommandsEl.value = Array.isArray(savedProject.commands) ? savedProject.commands.join("\\n") : "";
          setResult(JSON.stringify(savedProject, null, 2));
        } else {
          setResult("No saved settings for " + projectName + ". Add commands and save it.");
        }
        selectCandidateByName(projectName);
        refreshFormState();
        updateCurlExample();
      }

      function refreshFormState() {
        const name = projectNameEl.value.trim();
        const savedProject = savedProjectByName(name);
        formStateEl.className = "form-state";
        if (!name) {
          formStateEl.textContent = "No project selected.";
          return;
        }

        if (!savedProject) {
          formStateEl.classList.add("is-new");
          formStateEl.textContent = "New project. Save it to register this configuration.";
          markDirtyCandidate(name, false);
          return;
        }

        const dirty = hasUnsavedChanges(savedProject);
        formStateEl.classList.add(dirty ? "is-dirty" : "is-saved");
        formStateEl.textContent = dirty
          ? "Unsaved changes. Save project to update stored directories or commands."
          : "Saved settings loaded.";
        markDirtyCandidate(name, dirty);
      }

      function markDirtyCandidate(projectName, dirty) {
        for (const candidate of worktreeListEl.querySelectorAll(".project-candidate")) {
          if (candidate.dataset.projectName === projectName && dirty) {
            candidate.classList.add("is-dirty");
          } else {
            candidate.classList.remove("is-dirty");
          }
        }
      }

      function hasUnsavedChanges(project) {
        const savedPaths = Array.isArray(project.projectPaths)
          ? project.projectPaths.map(normalizeProjectPath).sort()
          : [];
        const currentPaths = currentProjectPaths(project.name).sort();
        return !sameValues(commandValues(), Array.isArray(project.commands) ? project.commands : [])
          || !sameValues(currentPaths, savedPaths);
      }

      function currentProjectPaths(projectName) {
        const group = directoryGroups.find((item) => item.projectName === projectName);
        return group ? group.entries.map((entry) => normalizeProjectPath(entry.path)) : [];
      }

      function sameValues(left, right) {
        if (left.length !== right.length) {
          return false;
        }

        return left.every((value, index) => value === right[index]);
      }

      function savedProjectByName(name) {
        return savedProjects.find((project) => project.name === name) || null;
      }

      function normalizeProjectPath(path) {
        const value = String(path);
        if (value.startsWith(projectRootPath + "/")) {
          return value.slice(projectRootPath.length + 1);
        }

        return value;
      }

      function displayProjectPath(path) {
        const value = String(path);
        if (value === projectRootPath) {
          return projectRootLabel;
        }

        if (value.startsWith(projectRootPath + "/")) {
          return projectRootLabel + "/" + value.slice(projectRootPath.length + 1);
        }

        return value;
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function escapeAttribute(value) {
        return escapeHtml(value).replaceAll(String.fromCharCode(96), "&#96;");
      }

      loadProjectRoot();
      updateCurlExample();
      refreshFormState();
    </script>
  </body>
</html>`;
}

/** 서버에서 HTML에 삽입할 텍스트를 escape합니다. */
function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
