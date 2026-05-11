# Mini CI
기존 local bare repo, Git hook, 전용 worktree, shell command만으로 동작하는 초경량 self-hosted CI입니다.

## 빠른 확인

```bash
npm run check
npm test
```

## 기본 사용

```bash
bin/mini-ci init
bin/mini-ci start
bin/mini-ci project attach /path/to/app --bare-repo /path/to/app.git --branch main --cmd "npm test"
```

상세 설계는 [PRD.md](./PRD.md), 브라우저용 문서는 [docs/PRD.html](./docs/PRD.html)을 참고하세요.
