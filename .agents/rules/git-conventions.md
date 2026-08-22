# Git Naming Conventions

브랜치 이름, 커밋 메시지, PR 제목, 태그에 대한 네이밍 규칙입니다.
모든 기여자와 AI 에이전트는 이 규칙을 따릅니다.

## 브랜치 이름

### 수동 생성 브랜치

```
<type>/<issue-number>-<kebab-case-description>
```

- **type** (필수): `feat`, `fix`, `chore`, `docs`, `refactor`, `test`
- **issue-number** (권장): GitHub 이슈 번호. 이슈 없는 소규모 작업은 생략 허용
- **description** (필수): kebab-case 영어 설명, 간결하게

예시:
- `feat/42-add-dark-mode`
- `fix/15-broken-ci-gate`
- `docs/update-readme`
- `chore/bump-dependencies`

### 자동 생성 브랜치 (규칙 적용 제외)

이 패턴들은 코드/도구에 의해 자동 생성되므로 위 규칙의 적용 대상이 아닙니다:

| 출처 | 패턴 | 예시 |
|---|---|---|
| 워크플로우 엔진 | `workflow/<issue>-<slug>` | `workflow/7-provider-override` |
| AI 에이전트 (Claude) | `claude/<kebab-topic>-<hex>` | `claude/ai-agent-setup-c92049` |
| AI 에이전트 (Codex) | `codex/<kebab-topic>` | `codex/ai-agent-setup` |

## 커밋 메시지

[Conventional Commits](https://www.conventionalcommits.org/) 형식을 따릅니다.

### 형식

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 필드 규칙

| 필드 | 필수 | 규칙 |
|---|---|---|
| type | ✅ | 아래 허용 타입 참조 |
| scope | ❌ | 아래 허용 스코프 참조 |
| subject | ✅ | imperative mood, sentence case, 마침표 없음, 50자 이내 |
| body | ❌ | 72자 wrap, root cause와 rationale 설명 (비자명한 변경에 한함) |
| footer | ❌ | `BREAKING CHANGE:`, `Closes #<n>`, `Refs #<n>` |

### 허용 타입

| type | 용도 |
|---|---|
| `feat` | 새로운 기능 |
| `fix` | 버그 수정 |
| `chore` | 빌드, 의존성, 설정 등 비기능 변경 |
| `docs` | 문서 변경 |
| `refactor` | 동작 변경 없는 코드 구조 개선 |
| `test` | 테스트 추가/수정 |
| `style` | 포맷팅, 세미콜론 등 코드 의미에 영향 없는 변경 |
| `perf` | 성능 개선 |
| `ci` | CI 설정 변경 |

### 허용 스코프

| scope | 대상 디렉토리/영역 |
|---|---|
| `core` | `core/` |
| `cli` | `cli/` |
| `electron` | `electron/` |
| `ui` | `src/` (React renderer) |
| `ai` | `core/ai/` |
| `workflow` | `core/workflow-engine.ts` 및 관련 |
| `github` | `core/github-service.ts` 및 관련 |

### 예시

단순 변경:
```
fix(ui): Correct dark mode toggle state on reload
```

비자명한 변경 (body 포함):
```
feat(ui): Add dark mode toggle to settings panel

The system-preference detection uses matchMedia('prefers-color-scheme')
and falls back to the stored user preference on load.

Closes #42
```

Breaking change:
```
refactor(core)!: Change MaoStore interface to async

All store methods now return Promise. This requires updates to both
electron/store.ts and FileStore implementations.

BREAKING CHANGE: MaoStore.get() and MaoStore.set() are now async.
Closes #50
```

### 언어

커밋 메시지는 **영어**로 작성합니다.

## PR 제목

커밋 메시지와 동일한 형식을 사용합니다:

```
<type>(<scope>): <subject>
```

PR body에 `Closes #<number>` 또는 `Fixes #<number>`로 이슈를 연결합니다.

## 태그 / 릴리스

[Semantic Versioning](https://semver.org/)을 따릅니다:

```
v<major>.<minor>.<patch>
```

- `v0.1.0`, `v1.0.0`, `v1.2.3`
- pre-release: `v1.0.0-alpha.1`, `v1.0.0-beta.2`
