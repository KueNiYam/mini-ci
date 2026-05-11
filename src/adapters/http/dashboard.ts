import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  getJob,
  getJobLog,
  getLatestJob,
  getLatestJobForProject,
  getProjects,
  getRecentJobs,
  getRecentJobsForProject,
  rerunJob,
} from "../../app.ts";

/** 대시보드 서버 실행에 필요한 로컬 런타임 설정입니다. */
export type DashboardOptions = Readonly<{
  home: string;
  port: number;
}>;

/** Mini CI 대시보드와 JSON API 서버를 시작합니다. */
export function startDashboard(options: DashboardOptions): void {
  const server = createServer((request, response) => {
    handleRequest(options.home, request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.listen(options.port, "127.0.0.1", () => {
    console.log(`Dashboard: http://localhost:${options.port}`);
  });
}

/** 요청 경로에 맞는 dashboard HTML 또는 API 응답을 반환합니다. */
async function handleRequest(home: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") {
    sendHtml(response, dashboardHtml());
    return;
  }

  if (method === "GET" && url.pathname === "/api/jobs/latest") {
    sendJson(response, 200, getLatestJob(home));
    return;
  }

  if (method === "GET" && url.pathname === "/api/jobs") {
    sendJson(response, 200, getRecentJobs(home));
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, getProjects(home));
    return;
  }

  const projectLatestMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/latest$/);
  if (method === "GET" && projectLatestMatch) {
    sendJson(response, 200, getLatestJobForProject(home, decodeURIComponent(projectLatestMatch[1])));
    return;
  }

  const projectJobsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/jobs$/);
  if (method === "GET" && projectJobsMatch) {
    sendJson(response, 200, getRecentJobsForProject(home, decodeURIComponent(projectJobsMatch[1])));
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch) {
    const job = getJob(home, jobMatch[1]);
    if (!job) {
      sendJson(response, 404, { error: "job not found" });
      return;
    }

    sendJson(response, 200, job);
    return;
  }

  const logsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    const log = getJobLog(home, logsMatch[1]);
    if (log === null) {
      sendJson(response, 404, { error: "job not found" });
      return;
    }

    sendText(response, 200, log);
    return;
  }

  const rerunMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/rerun$/);
  if (method === "POST" && rerunMatch) {
    sendJson(response, 201, rerunJob(home, rerunMatch[1]));
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
      h1 {
        margin: 0 0 24px;
        font-size: 2rem;
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
      button {
        border: 0;
        border-radius: 6px;
        background: #0f766e;
        color: white;
        padding: 9px 13px;
        font-weight: 700;
        cursor: pointer;
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
      a {
        color: #0f766e;
        font-weight: 700;
      }
      .project-list {
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
      <h1>Mini CI Dashboard</h1>
      <section>
        <h2>Projects</h2>
        <div id="projects" class="project-list"></div>
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
      let currentJob = null;
      let selectedProjectId = "all";
      const projectNames = new Map();

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
            escapeHtml(job.commitSha.slice(0, 7)) + "</button> " +
            escapeHtml(job.status) + " " +
            escapeHtml(job.createdAt) +
            "</li>";
        }).join("");
      }

      async function loadProjects() {
        const projects = await fetch("/api/projects").then((response) => response.json());
        projectNames.clear();
        projectsEl.replaceChildren(projectButton("all", "All projects"));
        for (const project of projects) {
          projectNames.set(project.id, project.name);
          projectsEl.append(projectButton(project.id, project.name));
        }
      }

      function renderJob(job) {
        rerunEl.disabled = false;
        jobEl.innerHTML = [
          ["프로젝트", escapeHtml(job.projectName || projectNames.get(job.projectId) || job.projectId)],
          ["상태", '<span class="status">' + escapeHtml(job.status) + "</span>"],
          ["커밋", escapeHtml(job.commitSha)],
          ["실패 step", escapeHtml(job.failedStep || "-")],
          ["exit code", escapeHtml(job.exitCode ?? "-")],
          ["생성", escapeHtml(job.createdAt)],
        ].map(([key, value]) => "<dt>" + key + "</dt><dd>" + value + "</dd>").join("");
      }

      function projectButton(id, label) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.setAttribute("aria-pressed", String(selectedProjectId === id));
        button.addEventListener("click", async () => {
          selectedProjectId = id;
          await load();
        });
        return button;
      }

      function latestUrl() {
        if (selectedProjectId === "all") {
          return "/api/jobs/latest";
        }

        return "/api/projects/" + encodeURIComponent(selectedProjectId) + "/latest";
      }

      function jobsUrl() {
        if (selectedProjectId === "all") {
          return "/api/jobs";
        }

        return "/api/projects/" + encodeURIComponent(selectedProjectId) + "/jobs";
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
        await fetch("/api/jobs/" + currentJob.id + "/rerun", { method: "POST" });
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
