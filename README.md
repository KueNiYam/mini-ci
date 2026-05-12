# Mini CI

Mini CI is a tiny self-hosted CI that runs shell commands against an already deployed directory.

> Mini CI는 이미 배포된 디렉터리에서 shell command를 실행하는 초경량 self-hosted CI입니다.

## Features

Register a directory on the CI machine and run commands there.

> CI가 실행되는 머신의 디렉터리를 등록하고, 그 위치에서 command를 실행합니다.

Trigger runs over HTTP without extra credentials.

> 추가 credential 없이 HTTP 요청으로 run을 시작합니다.

Run requests return immediately with a job ID, and command output is appended to the job log while the job runs.

> run 요청은 job ID를 즉시 반환하고, command 출력은 job 실행 중 job log에 계속 누적됩니다.

View project/worktree history, logs, and rerun actions in the dashboard.

> 대시보드에서 프로젝트/worktree별 이력, 로그, rerun을 확인할 수 있습니다.

## Requirements

- Node.js 24 or newer
- `sqlite3` CLI

## Quick Check

```bash
npm run check
npm test
```

## Basic Usage

Start Mini CI.

> Mini CI를 시작합니다.

```bash
MINI_CI_PORT="<port>"
bin/mini-ci start --host 0.0.0.0 --port "${MINI_CI_PORT}"
```

Register the project once from `/admin`, then let the client deployment process refresh and run it through HTTP.

> 프로젝트는 `/admin`에서 한 번 등록하고, 이후 클라이언트 배포 프로세스가 HTTP로 갱신과 실행을 호출하게 합니다.

Project paths are discovered by project name under `~/.codex/worktrees` by default. Set `MINI_CI_PROJECT_ROOT` to use another base directory.

> 프로젝트 경로는 기본적으로 `~/.codex/worktrees` 아래에서 프로젝트명으로 자동 탐지합니다. 다른 기준 디렉터리를 쓰려면 `MINI_CI_PROJECT_ROOT`를 설정합니다.

`WORKTREE_PATH` selects the worktree to run. `RUN_DATE` becomes the date row on the dashboard.

> `WORKTREE_PATH`는 실행할 worktree를 선택합니다. `RUN_DATE`는 대시보드의 날짜 행으로 표시됩니다.

```bash
MINI_CI_URL="http://<mini-ci-host>:<port>"
PROJECT_NAME="<project-name>"
WORKTREE_ID="<worktree-id>"
WORKTREE_PATH="${WORKTREE_ID}/${PROJECT_NAME}"
RUN_DATE="$(date +%Y%m%d%H%M%S)"
COMMANDS='["npm test"]'

curl -X POST "${MINI_CI_URL}/api/admin/projects" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${PROJECT_NAME}\",\"paths\":[\"${WORKTREE_PATH}\"],\"commands\":${COMMANDS}}"

curl -X POST "${MINI_CI_URL}/api/projects/${PROJECT_NAME}/runs" \
  -H "Content-Type: application/json" \
  -d "{\"worktreePath\":\"${WORKTREE_PATH}\",\"runDate\":\"${RUN_DATE}\"}"
```

The run API returns `202 Accepted` with `jobId`. Check the dashboard or `GET /api/jobs/:id` for `queued`, `running`, `success`, `failed`, or `interrupted`.

> run API는 `202 Accepted`와 `jobId`를 반환합니다. `queued`, `running`, `success`, `failed`, `interrupted` 상태는 대시보드나 `GET /api/jobs/:id`에서 확인합니다.

## Integrating Another Project

Give the target Git URL and README to the deployment process, then prepare the source under `~/.codex/worktrees/<WORKTREE_ID>/<PROJECT_NAME>`, register it in `/admin`, and trigger `POST /api/projects/:name/runs`.

> 대상 Git URL과 README를 배포 프로세스에 제공한 뒤, 소스를 `~/.codex/worktrees/<WORKTREE_ID>/<PROJECT_NAME>` 아래에 준비하고 `/admin`에서 등록한 다음 `POST /api/projects/:name/runs`로 실행합니다.

Mini CI does not clone Git URLs by itself yet. The target README should make the project name and test commands clear.

> Mini CI가 아직 Git URL을 직접 clone하지는 않습니다. 대상 README에는 프로젝트명과 테스트 command가 명확해야 합니다.

## API

```text
GET /api/projects
GET /api/jobs/latest
GET /api/jobs
GET /api/projects/:name/latest
GET /api/projects/:name/jobs
POST /api/projects/:name/runs
GET /api/jobs/:id
GET /api/jobs/:id/logs
POST /api/jobs/:id/rerun
GET /api/admin/project-root
POST /api/admin/projects
```

## Documentation

Published guide: [Mini CI WIKI](https://kueniyam.github.io/mini-ci/)

> 공개 문서: [Mini CI WIKI](https://kueniyam.github.io/mini-ci/)

Operations guide: [docs/WIKI.html](./docs/WIKI.html)

> 운영 가이드: [docs/WIKI.html](./docs/WIKI.html)
