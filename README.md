# Mini CI

Mini CI is a tiny self-hosted CI for local bare repos, Git hooks, dedicated worktrees, and shell commands.

> Mini CI는 local bare repo, Git hook, 전용 worktree, shell command만으로 동작하는 초경량 self-hosted CI입니다.

## Features

Attach an existing local bare repo without changing the app repository remote.

> 기존 local bare repo를 연결하되, 개발 프로젝트의 remote 설정은 변경하지 않습니다.

Run commands in a Mini CI-managed worktree when `git push origin main` triggers `post-receive`.

> `git push origin main`으로 `post-receive`가 실행되면 Mini CI 전용 worktree에서 명령을 실행합니다.

Store job state in SQLite and full logs as files.

> job 상태는 SQLite에, 전체 로그는 파일로 저장합니다.

View latest jobs, project-specific history, logs, and rerun actions in the dashboard.

> 대시보드에서 최신 job, 프로젝트별 이력, 로그, rerun을 확인할 수 있습니다.

## Requirements

- Node.js 24 or newer
- Git
- `sqlite3` CLI

## Quick Check

```bash
npm run check
npm test
```

## Basic Usage

Initialize Mini CI and start the dashboard.

> Mini CI 실행 환경을 만들고 대시보드를 시작합니다.

```bash
bin/mini-ci init
bin/mini-ci start
```

Attach an existing local bare repo.

> 기존 local bare repo를 연결합니다.

```bash
bin/mini-ci project attach /path/to/app --bare-repo /path/to/app.git --branch main --cmd "npm test"
```

Push to the app repo to trigger CI.

> 앱 저장소에서 push하면 CI가 실행됩니다.

```bash
cd /path/to/app
git push origin main
```

## Dashboard

```text
http://localhost:4177
```

The dashboard shows all projects by default and can filter jobs by project.

> 대시보드는 기본적으로 전체 프로젝트를 보여주며, 프로젝트별 job 필터링을 지원합니다.

## API

```text
GET /api/projects
GET /api/jobs/latest
GET /api/jobs
GET /api/projects/:id/latest
GET /api/projects/:id/jobs
GET /api/jobs/:id
GET /api/jobs/:id/logs
POST /api/jobs/:id/rerun
```

## Documentation

Detailed design: [docs/PRD.html](./docs/PRD.html)

> 상세 설계: [docs/PRD.html](./docs/PRD.html)
