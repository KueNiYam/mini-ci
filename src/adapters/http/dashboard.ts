import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  getJob,
  getJobLog,
  getLatestJob,
  getLatestJobForProjectName,
  getProjects,
  getRecentJobs,
  getRecentJobsForProjectName,
  isTriggerTokenConfigured,
  rerunJob,
  runProjectByName,
  setTriggerToken,
  verifyTriggerToken,
} from "../../app.ts";

/** 대시보드 서버 실행에 필요한 로컬 런타임 설정입니다. */
export type DashboardOptions = Readonly<{
  home: string;
  host: string;
  port: number;
  adminToken?: string;
}>;

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

  if (method === "GET" && url.pathname === "/") {
    sendHtml(response, dashboardHtml());
    return;
  }

  if (method === "GET" && url.pathname === "/admin") {
    sendHtml(response, adminHtml());
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

  if (method === "GET" && url.pathname === "/api/admin/trigger-token") {
    if (!requireAdminToken(options, request, response)) return;
    sendJson(response, 200, { configured: isTriggerTokenConfigured(options.home) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/admin/trigger-token") {
    if (!requireAdminToken(options, request, response)) return;
    const body = await readJsonBody(request);
    const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
    sendJson(response, 201, {
      configured: true,
      token: setTriggerToken(options.home, token),
    });
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
    if (!requireTriggerToken(options.home, request, response)) return;
    const body = await readJsonBody(request);
    const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
    try {
      sendJson(response, 201, runProjectByName(options.home, {
        name: decodeURIComponent(projectRunsMatch[1]),
        ref,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("프로젝트를 찾을 수 없습니다")) {
        sendJson(response, 404, { error: error.message });
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
    if (!requireTriggerToken(options.home, request, response)) return;
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
function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
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

/** trigger token이 유효한지 검사하고 실패 응답을 보냅니다. */
function requireTriggerToken(home: string, request: IncomingMessage, response: ServerResponse): boolean {
  if (!isTriggerTokenConfigured(home)) {
    sendJson(response, 409, { error: "trigger token is not configured" });
    return false;
  }

  const token = bearerToken(request);
  if (!token || !verifyTriggerToken(home, token)) {
    sendJson(response, 401, { error: "invalid trigger token" });
    return false;
  }

  return true;
}

/** admin token이 유효한지 검사하고 실패 응답을 보냅니다. */
function requireAdminToken(options: DashboardOptions, request: IncomingMessage, response: ServerResponse): boolean {
  if (!options.adminToken) {
    sendJson(response, 503, { error: "MINI_CI_ADMIN_TOKEN is not configured" });
    return false;
  }

  const token = bearerToken(request);
  if (!token || !safeEqualText(token, options.adminToken)) {
    sendJson(response, 401, { error: "invalid admin token" });
    return false;
  }

  return true;
}

/** Authorization header에서 Bearer token만 추출합니다. */
function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value) {
    return null;
  }

  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** 문자열 token을 길이 차이 예외 없이 비교합니다. */
function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** 대시보드 단일 HTML 문서를 반환합니다. */
function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini CI Dashboard</title>
    <style>
      body {
        margin: 0;
        background: #f7f8fa;
        color: #1d2430;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 40px 20px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 24px;
      }
      h1, h2 {
        margin-top: 0;
      }
      section {
        margin-bottom: 24px;
        border: 1px solid #d9dee8;
        border-radius: 8px;
        background: white;
        padding: 20px;
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
      .status {
        display: inline-flex;
        border-radius: 999px;
        background: #e6f4f1;
        color: #0b5f59;
        padding: 3px 9px;
        font-weight: 700;
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
      .project-list button,
      .history-button {
        border: 1px solid #d9dee8;
        background: #fbfcfe;
        color: #1d2430;
      }
      .project-list button[aria-pressed="true"] {
        border-color: #0f766e;
        background: #e6f4f1;
        color: #0b5f59;
      }
      .history-button {
        padding: 3px 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Mini CI Dashboard</h1>
        <a class="button" href="/admin">Admin</a>
      </header>
      <section>
        <h2>Projects</h2>
        <div id="projects" class="project-list"></div>
      </section>
      <section>
        <h2>Run</h2>
        <form id="run-form" class="run-form">
          <input id="run-ref" name="ref" placeholder="ref" />
          <button type="submit">Run selected project</button>
        </form>
      </section>
      <section>
        <dl id="job"></dl>
        <p><button id="rerun" type="button">Rerun</button></p>
      </section>
      <section>
        <pre id="logs">loading...</pre>
      </section>
      <section>
        <h2>History</h2>
        <ul id="history"></ul>
      </section>
    </main>
    <script>
      const jobEl = document.getElementById("job");
      const logEl = document.getElementById("logs");
      const rerunEl = document.getElementById("rerun");
      const historyEl = document.getElementById("history");
      const projectsEl = document.getElementById("projects");
      const runFormEl = document.getElementById("run-form");
      const runRefEl = document.getElementById("run-ref");
      let currentJob = null;
      let selectedProjectName = "all";

      async function load() {
        await loadProjects();
        const latest = await fetch(latestUrl()).then((response) => response.json());
        currentJob = latest;
        if (!latest) {
          jobEl.innerHTML = "<dt>상태</dt><dd>아직 job이 없습니다.</dd>";
          logEl.textContent = "";
          rerunEl.disabled = true;
          await loadHistory();
          return;
        }

        renderJob(latest);
        logEl.textContent = await fetch("/api/jobs/" + latest.id + "/logs").then((response) => response.text());
        await loadHistory();
      }

      async function loadHistory() {
        const jobs = await fetch(jobsUrl()).then((response) => response.json());
        historyEl.innerHTML = jobs.map((job) => {
          return "<li><button class='history-button' type='button' data-job-id='" + escapeAttribute(job.id) + "'>" +
            escapeHtml(job.projectName) + " " +
            escapeHtml(job.ref) + "</button> " +
            escapeHtml(job.status) + " " +
            escapeHtml(job.createdAt) +
            "</li>";
        }).join("");
      }

      async function loadProjects() {
        const projects = await fetch("/api/projects").then((response) => response.json());
        projectsEl.replaceChildren(projectButton("all", "All projects"));
        for (const project of projects) {
          projectsEl.append(projectButton(project.name, project.name));
        }
      }

      function renderJob(job) {
        rerunEl.disabled = false;
        jobEl.innerHTML = [
          ["프로젝트", escapeHtml(job.projectName || job.projectId)],
          ["상태", '<span class="status">' + escapeHtml(job.status) + "</span>"],
          ["Ref", escapeHtml(job.ref)],
          ["실패 step", escapeHtml(job.failedStep || "-")],
          ["exit code", escapeHtml(job.exitCode ?? "-")],
          ["생성", escapeHtml(job.createdAt)],
        ].map(([key, value]) => "<dt>" + key + "</dt><dd>" + value + "</dd>").join("");
      }

      function projectButton(name, label) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.setAttribute("aria-pressed", String(selectedProjectName === name));
        button.addEventListener("click", async () => {
          selectedProjectName = name;
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

      async function triggerHeaders() {
        let token = sessionStorage.getItem("miniCiTriggerToken");
        if (!token) {
          token = prompt("Trigger token");
          if (token) sessionStorage.setItem("miniCiTriggerToken", token);
        }

        return token ? { Authorization: "Bearer " + token } : {};
      }

      historyEl.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-job-id]");
        if (!button) return;

        const job = await fetch("/api/jobs/" + encodeURIComponent(button.dataset.jobId)).then((response) => response.json());
        currentJob = job;
        renderJob(job);
        logEl.textContent = await fetch("/api/jobs/" + encodeURIComponent(job.id) + "/logs").then((response) => response.text());
      });

      rerunEl.addEventListener("click", async () => {
        if (!currentJob) return;
        const response = await fetch("/api/jobs/" + currentJob.id + "/rerun", {
          method: "POST",
          headers: await triggerHeaders(),
        });
        if (!response.ok) {
          sessionStorage.removeItem("miniCiTriggerToken");
          alert(await response.text());
          return;
        }
        await load();
      });

      runFormEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (selectedProjectName === "all") {
          alert("Select one project");
          return;
        }

        const response = await fetch("/api/projects/" + encodeURIComponent(selectedProjectName) + "/runs", {
          method: "POST",
          headers: {
            ...(await triggerHeaders()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: runRefEl.value.trim() || undefined }),
        });
        if (!response.ok) {
          sessionStorage.removeItem("miniCiTriggerToken");
          alert(await response.text());
          return;
        }

        runRefEl.value = "";
        await load();
      });

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

      load();
      setInterval(load, 3000);
    </script>
  </body>
</html>`;
}

/** trigger token 관리를 위한 admin HTML 문서를 반환합니다. */
function adminHtml(): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini CI Admin</title>
    <style>
      body {
        margin: 0;
        background: #f7f8fa;
        color: #1d2430;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 40px 20px;
      }
      section {
        margin-bottom: 24px;
        border: 1px solid #d9dee8;
        border-radius: 8px;
        background: white;
        padding: 20px;
      }
      label {
        display: grid;
        gap: 6px;
        margin-bottom: 14px;
        font-weight: 700;
      }
      input {
        min-height: 36px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 0 10px;
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
      pre {
        overflow: auto;
        border-radius: 8px;
        background: #101828;
        color: #eef2f7;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Mini CI Admin</h1>
      <p><a href="/">Dashboard</a></p>
      <section>
        <label>
          Admin token
          <input id="admin-token" type="password" autocomplete="current-password" />
        </label>
        <label>
          Trigger token
          <input id="trigger-token" autocomplete="off" />
        </label>
        <button id="save" type="button">Save trigger token</button>
        <button id="generate" type="button">Generate trigger token</button>
      </section>
      <section>
        <h2>Result</h2>
        <pre id="result">-</pre>
      </section>
    </main>
    <script>
      const adminTokenEl = document.getElementById("admin-token");
      const triggerTokenEl = document.getElementById("trigger-token");
      const resultEl = document.getElementById("result");

      document.getElementById("save").addEventListener("click", async () => {
        await saveToken(triggerTokenEl.value.trim());
      });

      document.getElementById("generate").addEventListener("click", async () => {
        await saveToken(undefined);
      });

      async function saveToken(token) {
        const response = await fetch("/api/admin/trigger-token", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + adminTokenEl.value,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(token ? { token } : {}),
        });
        const text = await response.text();
        resultEl.textContent = text;
        if (response.ok) {
          const body = JSON.parse(text);
          triggerTokenEl.value = body.token || "";
        }
      }
    </script>
  </body>
</html>`;
}
