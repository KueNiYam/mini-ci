# Mini CI

Mini CI is a tiny self-hosted CI that runs shell commands against an already deployed directory.

> Mini CI는 이미 배포된 디렉터리에서 shell command를 실행하는 초경량 self-hosted CI입니다.

## Features

Register a directory on the CI machine and run commands there.

> CI가 실행되는 머신의 디렉터리를 등록하고, 그 위치에서 command를 실행합니다.

Trigger runs over HTTP without extra credentials.

> 추가 credential 없이 HTTP 요청으로 run을 시작합니다.

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
bin/mini-ci start --host 0.0.0.0 --port 4177
```

Register the project once from `/admin`, then let the client deployment process refresh and run it through HTTP.

> 프로젝트는 `/admin`에서 한 번 등록하고, 이후 클라이언트 배포 프로세스가 HTTP로 갱신과 실행을 호출하게 합니다.

Project paths are discovered by project name under `~/.codex/worktrees` by default. Set `MINI_CI_PROJECT_ROOT` to use another base directory.

> 프로젝트 경로는 기본적으로 `~/.codex/worktrees` 아래에서 프로젝트명으로 자동 탐지합니다. 다른 기준 디렉터리를 쓰려면 `MINI_CI_PROJECT_ROOT`를 설정합니다.

`WORKTREE_PATH` selects the worktree to run. `RUN_DATE` becomes the date row on the dashboard.

> `WORKTREE_PATH`는 실행할 worktree를 선택합니다. `RUN_DATE`는 대시보드의 날짜 행으로 표시됩니다.

```bash
PROJECT_NAME="storyboard"
WORKTREE_ID="1cf2"
WORKTREE_PATH="${WORKTREE_ID}/${PROJECT_NAME}"
RUN_DATE="$(date +%Y%m%d%H%M%S)"
COMMANDS='["npm test"]'

curl -X POST http://kueni-16.local:4177/api/admin/projects \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${PROJECT_NAME}\",\"paths\":[\"${WORKTREE_PATH}\"],\"commands\":${COMMANDS}}"

curl -X POST "http://kueni-16.local:4177/api/projects/${PROJECT_NAME}/runs" \
  -H "Content-Type: application/json" \
  -d "{\"worktreePath\":\"${WORKTREE_PATH}\",\"runDate\":\"${RUN_DATE}\"}"
```

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

Operations guide: [docs/WIKI.html](./docs/WIKI.html)

> 운영 가이드: [docs/WIKI.html](./docs/WIKI.html)
