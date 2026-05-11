# Mini CI

Mini CI is a tiny self-hosted CI that runs shell commands against an already deployed directory.

> Mini CI는 이미 배포된 디렉터리에서 shell command를 실행하는 초경량 self-hosted CI입니다.

## Features

Register a directory on the CI machine and run commands there.

> CI가 실행되는 머신의 디렉터리를 등록하고, 그 위치에서 command를 실행합니다.

Trigger runs over HTTP with a bearer token.

> bearer token이 포함된 HTTP 요청으로 run을 시작합니다.

Manage the trigger token from the admin page.

> admin 페이지에서 trigger token을 생성하거나 교체합니다.

View projects, history, logs, and rerun actions in the dashboard.

> 대시보드에서 프로젝트, 이력, 로그, rerun을 확인할 수 있습니다.

## Requirements

- Node.js 24 or newer
- `sqlite3` CLI

## Quick Check

```bash
npm run check
npm test
```

## Basic Usage

Start Mini CI with an admin token.

> admin token과 함께 Mini CI를 시작합니다.

```bash
MINI_CI_ADMIN_TOKEN=admin-secret bin/mini-ci start --host 0.0.0.0 --port 4177
```

Register a deployed directory.

> 배포된 디렉터리를 등록합니다.

```bash
bin/mini-ci project add storyboard --path /Users/kueni-16/ci-sources/storyboard/current --cmd "test -f README.md"
```

Create a trigger token from `/admin`, then trigger a run.

> `/admin`에서 trigger token을 만든 뒤 run을 시작합니다.

```bash
curl -X POST http://kueni-16.local:4177/api/projects/storyboard/runs \
  -H "Authorization: Bearer $MINI_CI_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ref":"manual-20260511"}'
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
POST /api/admin/trigger-token
```

## Documentation

Operations guide: [docs/WIKI.html](./docs/WIKI.html)

> 운영 가이드: [docs/WIKI.html](./docs/WIKI.html)
