# 감사 원자료: UX · DX · 문서

> 2026-11-12, `origin/main` `ac0915e` 기준. 하위 에이전트가 저장소를 읽기 전용으로 검토해 낸 결과를 편집 없이 실었습니다.
> 일부 세부(줄 번호 등)는 이슈를 작성하면서 정정했습니다. 어긋나면 이슈 본문과 [project-review-2026-11.md](../project-review-2026-11.md)가 우선합니다.
> 본문의 "코디네이터가 확인한 사실 1~6"은 그 문서 2절의 1, 2, 3, 6, 7, 8·13번 행에 해당합니다.
> 확신 표기: verified(코드를 읽어 확인), likely(추정), speculative(가설).

## 방향성 판정: needs-major-course-correction
최근 3개월 동안 사용자가 체감하는 개선은 사실상 없었다. 마지막 기능 머지는 2026-09-08(#54)이고, 10월 머지 11건 중 7건은 store 손상 방어였다. v0.2.0 UI 백로그(#96 커밋 그래프, #102 연결선, #108/#109 디자인 시스템 3종, #97 다국어)는 화면을 꾸미는 일이고, 사용자가 실제로 겪는 흐름(첫 실행 → 작업 생성 → 진행 관찰 → 개입 → 승인 → 복구)의 구멍은 그대로 남아 있다. 구체적으로 이렇다. 저장소를 추가하면 곧바로 무인 머지가 켜진다. 실행 중인 작업을 멈출 수단이 GUI와 CLI 어디에도 없다. 리뷰 판정이나 diff를 보고 머지를 승인하는 화면이 없다. 여러 저장소를 가로질러 "지금 내가 처리할 일"을 보여 주는 화면도 없다. CLI의 enqueue/retry/advance는 큐 전체를 출력 없이 포그라운드에서 실행한다. 사람이 읽을 문서는 README 151줄이 전부이고, 운영 지식은 에이전트용 AGENTS.md(105KB) 안에만 있다. 방향을 "안전한 기본값 + 미션 컨트롤(주의 인박스·실행 타임라인·승인 화면) + 사람용 문서" 쪽으로 크게 틀어야 한다. 외관 작업은 동결해야 한다.

## 강점
- 어떤 에이전트가 어느 단계를 맡는지(maker-checker)가 화면에 드러난다. AgentBadge가 단계마다 provider/도구/model/effort를 보여 주고, 아직 실행 전인 작업에도 previewStageAgent로 'up next' 에이전트를 미리 표시한다. 엔진과 같은 core/agent-selection.ts 코드를 쓰므로 화면 표시와 실제 실행이 어긋나지 않는다(src/components/WorkflowQueue.tsx:86-142).
- 저장소를 추가할 때 'Checking access…' 단계에서 권한을 검사한다(src/components/Sidebar.tsx:599-600, core/repo-capabilities.ts:186,305). 첫 실행 경험에서 드물게 잘 된 부분이다.
- 오류 메시지에 값을 담지 않는다는 원칙이 일관되게 지켜진다. config 파일에 평문 토큰이 있으므로 백엔드 오류 원문을 노출하지 않는다(cli/index.ts:434-435). 보안과 사용자 경험 모두에 좋은 결정이다.
- cron 용도의 `mao run`은 복구가 필요한 상태에서 0이 아닌 종료 코드를 내고 아무것도 시작하지 않는다(cli/index.ts:489-505). swarm에는 --dry-run/--status가 있다.
- 키보드 포커스 링이 모든 디자인 프리셋에 공통으로 정의되어 있다(src/index.css:452-462 :focus-visible). KanbanBoard 카드는 role=button, tabIndex=0, Enter 처리를 갖췄다(KanbanBoard.tsx:175-178).
- README의 'Known limitations' 절이 CLI 에이전트의 메타 응답과 allowToolUse 권한 우회를 숨기지 않고 적어 둔다(README.md:146-151). 이슈/PR 템플릿도 갖춰져 있다(.github/ISSUE_TEMPLATE/*.yml, pull_request_template.md).

## 발견
### 1. 첫 실행에서 '저장소 추가'를 누르면 무인 머지 파이프라인이 바로 켜진다(위험한 기본값 + 안내 없는 환영 화면)
- 종류/심각도/노력/시점/확신: risk / critical / M / now / verified
- 근거: core/auto-trigger.ts:208에서 `autoTrigger = true`가 기본값이다. auto-trigger.ts:124는 enqueueFromIssue(..., true, ...)로 autoAdvance를 true로 고정한다. GUI의 새 작업 체크박스도 기본 true(WorkflowQueue.tsx:251)이고, 이슈 모달의 'Auto-advance through pr → review → merge unattended'도 기본 true(TaskDetailModal.tsx:43)이다. 환영 화면(App.tsx:779-785)은 'Add a repository from the sidebar...' 한 줄뿐이고 토큰, provider, 안전 수칙을 전혀 언급하지 않는다. 코디네이터가 확인한 사실과 합치면, 리뷰는 COMMENT로만 남고 CI가 'none'이어도 머지된다. 결과적으로 토큰과 provider를 넣고 저장소를 추가하는 순간 열린 이슈 최대 50개가 사람의 승인 없이 PR 생성 → 머지까지 진행될 수 있다.
- 권고: (1) 저장소를 추가할 때 autoTrigger 기본값을 false로 바꾸고 Settings에서 명시적으로 켜게 한다. 켤 때는 '열린 이슈 N개가 큐에 들어갑니다' 확인 대화상자를 띄운다. (2) autoAdvance 기본값을 false로 바꾸거나, 최소한 merge 단계 앞에 항상 멈추는 'merge gate'를 기본으로 둔다. (3) 환영 화면을 3단계 체크리스트(GitHub 토큰 → provider 2개 → 저장소)로 바꾸고 단계별 완료 상태와 '연결 테스트' 버튼을 붙인다. (4) 첫 작업은 '드라이런/수동 진행 모드'로 시작하도록 유도한다.
- 기존 커버리지: none (#1은 provider 고정 문제이고 기본값 문제는 다루지 않는다)

### 2. 실행 중이거나 대기 중인 작업을 멈추거나 취소하거나 삭제할 수단이 없다
- 종류/심각도/노력/시점/확신: gap / high / M / now / verified
- 근거: IPC 표면(electron/ipc.ts:119-145)에는 workflow:enqueue/list/retry/advance/setAutoAdvance/clearCompleted만 있다. WorkflowEngine 공개 메서드(core/workflow-engine.ts:314-656)에도 cancel/abort/remove가 없고 AbortController 사용처도 없다. CLI의 workflow 하위 명령(cli/index.ts:296-468)도 마찬가지다. auto-advance 체크를 끄면 다음 단계만 막힌다. 앱을 종료해도 restore()가 running을 pending으로 되돌려 다시 실행한다(workflow-engine.ts:519). 코디네이터가 확인한 대로 CLI 타임아웃은 직계 자식 프로세스만 종료한다.
- 권고: engine에 cancel(taskId)를 추가한다. 실행 중인 단계에 AbortSignal을 전달하고 프로세스 그룹 전체를 종료한 뒤 상태를 'cancelled'(새 상태값)로 기록한다. 대기 중인 작업은 remove(taskId)로 지운다. GUI 카드에는 'Stop'/'Remove' 버튼을, CLI에는 `mao workflow cancel <id>`와 `mao workflow rm <id>`를 추가한다. 'Pause after this stage'(현재 autoAdvance 토글)과 'Stop now'를 라벨로 구분한다.
- 기존 커버리지: none

### 3. '단계별 투명성'이 실질적으로 비어 있다: 실시간 출력, diff, CI 상태, 리뷰 판정, 머지 승인 화면이 모두 없다
- 종류/심각도/노력/시점/확신: gap / high / L / now / verified
- 근거: 실행 중 카드에는 live-dot과 프롬프트만 보인다(WorkflowQueue.tsx:144-161). 출력은 단계가 끝난 뒤 history의 <pre>로만 볼 수 있다(:182-192). cli-provider 출력은 버퍼링되어 스트리밍되지 않는다. 표시되는 프롬프트는 제목 한 문장뿐이다(workflow-engine.ts:125-136). TaskDetailModal은 본문, 라벨, 댓글만 보여 주고 PR의 변경 파일, diff, 체크 상태를 가져오지 않는다(TaskDetailModal.tsx:134-232). README.md:18이 내세우는 'Per-stage transparency'와 실제 기능 사이에 큰 차이가 있다.
- 권고: 작업 상세를 '실행 타임라인' 페이지로 만든다. 단계별 카드에는 에이전트, 경과 시간, stdout/stderr 스트림(줄 단위 IPC 이벤트), 종료 코드를 담는다. PR 단계에는 변경 파일 목록과 diff 요약(+/-)을, review 단계에는 리뷰 본문과 판정(approve/request-changes를 파싱한 결과)을 둔다. merge 단계 직전에는 CI 체크 목록과 'Approve & merge / Request revision / Reject' 버튼이 있는 승인 패널을 둔다. 엔진에 판정 파싱과 승인 대기 상태를 추가하는 작업과 반드시 함께 진행해야 한다.
- 기존 커버리지: #100 (마크다운 렌더링: 가독성만 다루고 diff/CI/승인은 none)

### 4. CLI의 enqueue/retry/advance가 저장된 큐 전체를 출력 없이 포그라운드에서 실행한다(GUI나 `mao run`과 중복 실행)
- 종류/심각도/노력/시점/확신: bug / high / M / now / likely
- 근거: appendTask가 `void this.processQueue()`를 호출한다(core/workflow-engine.ts:638). processQueue는 큐에 있는 모든 pending 작업을 순서대로 실행한다(:707-729). loadApp(resume=false)여도 restore()가 running을 pending으로 바꾼다(:519). 그래서 `mao workflow enqueue "x"` 한 번이 다른 프로세스(GUI)에서 실행 중인 작업까지 다시 돌린다. cli/index.ts:58-63의 주석('inspecting... never has the side effect of resuming')은 변경 명령에서는 지켜지지 않는다. 진행 로그 리스너는 `run`에만 달려 있으므로(:510-523) enqueue는 'Enqueued task …' 한 줄을 찍은 뒤 몇 분에서 몇십 분 동안 아무 말 없이 멈춘 것처럼 보인다. store-file.ts에는 쓰기 잠금만 있고 실행 잠금(단일 runner)은 없다.
- 권고: (1) enqueue/retry/advance/enqueue-existing을 엔진을 돌리지 않는 순수 큐 변경으로 만들고, 실행은 `mao run`(또는 GUI)만 맡게 한다. 즉시 실행이 필요하면 `--wait/--follow`로 해당 작업 하나만 따라가며 진행 로그를 출력한다. (2) dataDir에 runner 잠금(pid/host)을 두고 GUI와 `mao run`이 동시에 엔진을 돌리지 못하게 한다. 잠금이 잡혀 있으면 '다른 MAO 프로세스(pid N)가 실행 중' 안내를 보여 준다.
- 기존 커버리지: #73 (store 쓰기 충돌만 다룸, 실행 중복은 none)

### 5. `config set-token <token>`이 토큰을 argv로 받고, 출력 형식과 명령 체계가 일관되지 않으며, 진단과 초기화 명령이 없다
- 종류/심각도/노력/시점/확신: debt / medium / M / now / verified
- 근거: cli/index.ts:82 `set-token <token>` 때문에 토큰이 셸 히스토리와 ps에 노출된다. 버전은 '0.1.0'으로 하드코딩되어 있다(:75). list/show/check는 JSON만 출력하고(:37-39) 변경 명령은 '[mao]' 텍스트만 출력하며 --json 플래그는 없다. `repos add <owner> <repo>`는 위치 인자를 쓰는데 `workflow enqueue`는 --owner/--repo 필수 옵션을 쓰고, owner/repo 슬러그 형식은 어느 쪽도 받지 않는다(:208, :299-300). 실패 시 exitCode는 1 하나뿐이다(:586-589). `workflow show/logs`, `providers list/test`, `doctor`, `init`, 셸 completion이 없다. --effort를 검증하지 않고 캐스트만 한다(:334).
- 권고: `mao config set-token`은 인자가 없으면 stdin/프롬프트(마스킹)로 읽고, `--from-env GITHUB_TOKEN`과 `gh auth token` 연동을 지원한다. 모든 명령에 `--json`을 추가하고 사람용 기본 출력은 표 형식으로 한다. `<owner/repo>` 슬러그를 받는다. 종료 코드를 정의한다(2 사용법 오류, 3 설정 누락, 4 복구 필요). `mao init`(대화형으로 토큰, provider, 저장소 설정 후 안전한 기본값 적용), `mao doctor`(git/gh/claude/codex 존재와 버전, 토큰 scope, 저장소 권한, provider 핑, 데이터 디렉터리 잠금과 marker 상태 점검), `mao workflow show <id> [--follow]`를 추가한다. 버전은 package.json에서 주입한다.
- 기존 커버리지: #78 (--effort 검증만), 나머지 none

### 6. 저장소 간 '지금 나를 기다리는 것' 화면과 알림이 없어서, 수동 진행 모드에서 멈춘 작업이 방치된다
- 종류/심각도/노력/시점/확신: gap / high / L / next / verified
- 근거: 앱 정보 구조가 저장소 단위다(App.tsx:19 ProjectTab = board|queue|settings). Queue는 선택한 저장소 작업만 보여 준다(WorkflowQueue.tsx:273). electron/src/core 어디에도 Notification이나 dock badge 사용처가 없다(grep 결과 없음). paused 상태로 'Run next stage'를 기다리는 작업, error 작업, 리뷰를 기다리는 PR은 해당 저장소의 Queue 탭을 직접 열어야 보인다. isActiveTask가 review 단계에 있는 작업을 paused나 error 상태여도 'active'로 센다(WorkflowQueue.tsx:38-40). 그래서 '1 active' 표시가 실제와 다를 수 있다.
- 권고: 사이드바 맨 위에 '미션 컨트롤(Inbox)'을 둔다. 모든 저장소의 작업을 (1) 내 결정 필요(paused, 승인 대기, 머지 대기) (2) 실패(error, 재시도 가능) (3) 실행 중 (4) 최근 완료로 묶어 보여 준다. 각 항목에 저장소, 단계, 경과 시간, 다음에 할 행동 버튼을 붙인다. 사이드바의 저장소 항목에 주의 카운트 배지를 달고, OS 알림(승인 대기, 실패, 머지 완료)과 dock/taskbar 배지를 추가한다. 'active'의 정의는 running으로 좁힌다.
- 기존 커버리지: none

### 7. 복구 UX가 사이드바 안의 11px 문단 묶음이고, 그 안내('workflow-active 라벨이 남은 이슈 확인')는 따를 수 없다
- 종류/심각도/노력/시점/확신: debt / high / L / next / verified
- 근거: Sidebar.tsx(643줄)의 280-580줄에는 text-[11px]/text-xs 문단이 30개, 코드 주석이 101줄 있다. 복구 카드와 확인 대화상자가 좁은 사이드바에 쌓인다(:398-503). 안내문은 '대상 저장소에서 workflow-active 라벨이 남은 이슈와 반쯤 끝난 브랜치/PR을 확인하라'고 한다(core/store.ts:497,510, Sidebar.tsx:466). 그런데 그 라벨은 추가만 되고 제거되지 않는다. github-service.ts에 removeLabel이 없고 auto-trigger.ts:130과 workflow-engine.ts:913은 addLabel만 호출한다. 실제로 열린 이슈 23개가 모두 workflow-active를 달고 있다(데이터 팩 open-issues.json). 확인하라는 신호가 쓸모없는 상태다.
- 권고: 복구를 전용 전체 화면('Recovery')으로 옮긴다. 상단에 한 줄 상태와 오류 코드(예: MAO-Q01)를 두고, 이어서 자동 대조표를 보여 준다. 대조표는 큐에 있는 작업마다 GitHub 이슈, 브랜치, PR의 현재 상태를 API로 조회해 '완료/중복 위험/고아'로 분류한 것이다. 그 아래 체크리스트와 행동 버튼, 그리고 docs/troubleshooting.md#MAO-Q01 링크를 둔다. 긴 설명은 문서로 옮기고 UI 문구는 두 문장 이내로 줄인다. workflow-active 라벨은 작업이 done/error/cancel될 때 제거하거나 상태별 라벨(mao:running, mao:failed)로 바꾼다. addLabel 실패를 삼키지 말고 화면에 보여 준다.
- 기존 커버리지: #91, #81 (복구 경로의 정확성만 다룸), #112 (안내 문구 사실 오류), 라벨 수명주기와 대조표는 none

### 8. provider와 토큰 '연결 테스트'가 없다: IPC `ai:run`은 있는데 UI에서 쓰지 않고, CLI가 없으면 첫 단계에서야 실패한다
- 종류/심각도/노력/시점/확신: gap / medium / S / now / verified
- 근거: electron/ipc.ts:63 `ai:run`과 src/electron.d.ts:27 `run(providerId, prompt)`가 있지만 src/components의 어디에서도 호출하지 않는다. GlobalSettings의 GitHub 토큰 입력(GlobalSettings.tsx:585-588)에는 검증이나 scope 표시가 없다. 저장 후 'Saved' 메시지만 1.5초 보였다 사라진다(:511-512). provider 명령(placeholder 'Command (e.g. claude)', :248)이 PATH에 있는지, 버전이 맞는지, 로그인되어 있는지 확인하지 않는다. README.md:68은 args를 '-p'/'exec'로 직접 입력하라고 안내한다.
- 권고: provider 행마다 'Test' 버튼을 둔다. 짧은 핑 프롬프트로 ai:run을 호출해 지연 시간, 모델, 첫 줄 응답을 표시한다. CLI provider라면 which/버전 탐지와 알려진 CLI 프리셋(claude, codex 선택 시 args 자동 입력)을 제공한다. GitHub 토큰은 저장 즉시 /user와 scope 헤더를 확인해 '로그인: X, scope: repo, workflow' 배지로 보여 준다. 같은 로직을 `mao doctor`와 공유한다(core 모듈 하나로).
- 기존 커버리지: none

### 9. 사람용 문서가 사실상 없다. README는 기여자용 개발 설정과 기능 목록이고, 안전 수칙은 에이전트 문서 안에만 있다
- 종류/심각도/노력/시점/확신: gap / high / M / now / verified
- 근거: README.md의 첫 실행 경로는 `npm install && npm run dev`(:30-33)뿐이다. v0.1.0 릴리스 자산(dmg/zip/AppImage)이 있지만 README에 링크가 없고, 그 빌드는 10월 store 방어 이전인 3개월 전 것이다. 안전 수칙은 README에 2줄(:149-151)뿐인데 AGENTS.md의 'Safety rails' 절은 407-1072줄(약 665줄)로 에이전트만 대상으로 한다. 루트에 CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG가 없다. `gh api .../community/profile` 결과 health_percentage 57, code_of_conduct와 contributing은 null이다. 열린 PR #110은 에이전트 문서를 3계층으로 나눌 뿐 사람용 문서는 0이다.
- 권고: docs/를 Diátaxis 구조로 만든다. 구성은 (1) quickstart.md(릴리스 설치 → mao init → 테스트 저장소에서 수동 진행으로 첫 작업 1건, 10분 목표) (2) concepts.md(단계, maker-checker, auto-trigger, autoAdvance, 라벨) (3) providers.md(claude/codex/API 설정과 알려진 문제) (4) safety.md(전용 테스트 저장소, 브랜치 보호 필수, allowToolUse의 의미, 토큰 최소 scope, auto-trigger와 외부 작성자 이슈의 위험) (5) troubleshooting.md(오류 코드별 복구) (6) architecture.md와 docs/adr/(단일 JSON store, Python→TS swarm 같은 결정 기록)이다. 루트에는 SECURITY.md(비공개 신고 경로), CONTRIBUTING.md(언어 정책, 개발 설정, 테스트), CODE_OF_CONDUCT.md, CHANGELOG.md(release.yml이 생성)를 둔다. README는 한 줄 가치 제안, 스크린샷/GIF, 설치, Quickstart 링크, 안전 경고 박스 순으로 다시 쓴다. AGENTS.md의 사람에게도 필요한 내용은 docs/로 옮기고 AGENTS.md에서는 링크로 가리킨다.
- 기존 커버리지: #110/#104 (에이전트 문서 재배치만), 사람용 문서는 none

### 10. 업데이트 배너가 브랜치 보호 없는 main HEAD를 기준으로 삼고, CLI는 배포되지 않는다(배포 채널 부재)
- 종류/심각도/노력/시점/확신: risk / medium / S / next / verified
- 근거: core/self-update.ts의 MAO_SELF_UPDATE_TARGET = {owner:'dragoncowkarma', repo:'mao', branch:'main'}이고, 실행 중인 빌드 SHA를 main 최신 SHA와 비교해 UpdateBanner를 띄운다(App.tsx:760-768). main에는 브랜치 보호가 없고, 릴리스는 마일스톤이 닫힐 때만 발행된다(release.yml). package.json은 "private": true라서 `npx mao`나 `npm i -g` 경로가 없고, README는 `node dist-cli/index.cjs`를 직접 실행하라고 안내한다(README.md:46-50).
- 권고: 업데이트 확인을 GitHub Releases(latest 태그) 기준으로 바꾸고 배너에 릴리스 노트 요약과 링크를 넣는다. 원하는 사용자만 쓰도록 'nightly(main)' 채널을 설정으로 분리한다. CLI는 npm에 `@<scope>/mao`로 배포하거나 최소한 릴리스 자산에 dist-cli 단일 파일을 포함한다. `mao --version`이 커밋 SHA와 채널을 함께 출력하게 한다.
- 기존 커버리지: none (#106은 릴리스 자동 발행만)

### 11. 접근성 기초가 비어 있다: 탭, 모달, 상태 갱신에 ARIA가 없고 모션 감소 설정을 따르지 않는다
- 종류/심각도/노력/시점/확신: debt / medium / M / next / verified
- 근거: `grep -c 'aria-\|role='` 결과 App.tsx 0, Sidebar.tsx 0, WorkflowQueue.tsx 0, AgentRunControls.tsx 0, TaskDetailModal.tsx 1(Close 버튼)이다. 프로젝트 탭(App.tsx:796-815)은 role=tablist/tab/aria-selected가 없는 단순 버튼이다. TaskDetailModal은 Escape만 처리하고(:84-88) role=dialog, aria-modal, 포커스 트랩, 닫은 뒤 포커스 복귀가 없다. 2초 폴링으로 바뀌는 상태(WorkflowQueue.tsx:259)와 오류 메시지(:396-399)는 aria-live나 role=alert가 없어 스크린리더에 전달되지 않는다. live-dot 애니메이션에 prefers-reduced-motion 처리가 없다(index.css에 해당 미디어쿼리 없음). 반면 :focus-visible 링은 잘 갖춰져 있다(index.css:452-462).
- 권고: 탭에 WAI-ARIA Tabs 패턴(방향키 이동)을 적용한다. 모달에는 role=dialog, aria-labelledby, 포커스 트랩과 복귀를 넣는다. 큐 요약에 aria-live=polite를, 오류에 role=alert를 단다. prefers-reduced-motion에서는 live-dot 애니메이션을 끈다. 디자인 프리셋 3종 각각에 대해 상태 태그 대비 4.5:1을 검사하는 테스트를 design-system.test.ts에 추가한다. 미션 컨트롤에는 키보드 단축키(j/k 이동, a 승인, r 재시도)를 넣는다.
- 기존 커버리지: none

### 12. UI 백로그 우선순위가 사용자 여정과 어긋나 있고, 이미 해결된 #1이 v0.2.0에 열려 있다
- 종류/심각도/노력/시점/확신: process / medium / S / now / verified
- 근거: v0.2.0의 UI 항목 중 #96(커밋 그래프), #102(연결선), #108/#109(디자인 시스템 3종, +1544줄)는 첫 실행, 개입, 승인, 복구 어느 흐름도 개선하지 않는다. #97(다국어)는 전체 문구 카탈로그화를 요구하는데(open-issues.json #97 본문), 현재 복구 안내문의 양 때문에 번역 비용이 크다. #100(마크다운)만이 리뷰 출력 가독성에 직접 기여한다. #1은 이미 구현되어 있다. 근거는 AiProviderConfig.effort(core/ai/types.ts:13-35), QueuedTask.providerOverride(workflow-engine.ts:96-97), 이슈 본문 지시문 파싱(auto-trigger.ts:120 parseProviderOverride), GUI 실행 드롭다운(AgentRunControls.tsx:75-92), CLI의 --worker/--reviewer/--maintainer/--model/--effort(cli/index.ts:307-311)이다.
- 권고: #1은 구현 커밋을 링크하고 닫는다. 남은 차이(GUI의 새 작업 입력에서 역할 고정 불가, ipc.ts:119의 enqueue 시그니처)는 별도 이슈로 만든다. #96과 #102는 later로 내린다. #109는 디자인 프리셋을 1개로 줄이거나 현재 상태로 머지한 뒤 추가 프리셋을 동결한다. #97은 미션 컨트롤과 복구 문구 축약 이후로 미룬다. v0.2.0을 '미션 컨트롤 + 승인 게이트 + 안전 기본값'으로 다시 정의하고 #100을 그 안에 포함한다.
- 기존 커버리지: #1 (해결됨, 닫히지 않음), #96 #97 #100 #102 #108

### 13. 언어 정책이 정해져 있지 않다: 제품, 문서, 에이전트 문서는 영어, 이슈와 PR은 한국어, 릴리스 노트는 영어
- 종류/심각도/노력/시점/확신: process / low / S / now / verified
- 근거: README, UI 문구, CLI 도움말, AGENTS.md는 영어다. 열린 이슈 23개 중 #1을 뺀 대부분이 한국어 제목과 본문이고(데이터 팩), PR #109 제목도 한국어다. v0.1.0 릴리스 노트는 영어다. 저장소 설명은 'multi-agent orchestrator'이고 topics는 null, Discussions는 꺼져 있다(`gh repo view`). 외부 기여자는 이슈를 읽지 못하고, 한국어 사용자는 UI를 읽지 못한다.
- 권고: CONTRIBUTING.md에 정책을 한 단락으로 명시한다. 예: 공개 인터페이스(README, docs, UI 기본값, CLI, 릴리스 노트, 커밋)는 영어로 하고, 이슈 본문은 한국어와 영어 모두 허용하되 제목은 영어 conventional 형식으로 한다. README.ko.md를 제공한다. 저장소 설명을 'AI agents run your GitHub issue→PR→review→merge loop with maker-checker'처럼 구체적으로 바꾸고 topics(ai-agents, github-automation, claude-code, codex, electron, cli)를 추가한다. 사용자가 생기면 Discussions(Q&A)를 켠다.
- 기존 커버리지: #97 (UI 언어 전환만)

## 중단할 것
- 사용자 여정의 구멍(중지, 승인, 인박스)을 그대로 두고 외관 작업(디자인 시스템 3종 #108/#109, 연결선 #102, 커밋 그래프 #96)을 먼저 하는 것을 멈춘다.
- 복구 설명을 UI 문자열과 코드 주석에 문단 단위로 쓰는 것을 멈춘다(Sidebar.tsx는 주석 101줄, 11px 문단 30개). 설명은 docs/troubleshooting.md에 두고 UI에는 두 문장과 링크만 남긴다.
- 다중 호스트 store 쓰기 경합을 계속 방어하면서 정작 CLI 변경 명령이 엔진을 하나 더 띄우게 두는 것을 멈춘다. 쓰기 잠금보다 단일 runner 잠금이 먼저다.
- AGENTS.md와 SKILL.md를 유일한 문서로 키우는 것을 멈춘다. 사람용 문서가 0인 상태에서 에이전트 문서만 재배치하는 #110은 우선순위가 맞지 않는다.
- 위험한 기본값을 유지하는 것을 멈춘다. autoTrigger=true, autoAdvance=true, merge 자동 진행 기본값은 '편의'가 아니라 첫 사용자의 저장소를 망칠 수 있는 설정이다.
- 해결된 이슈(#1)를 열어 두고, 모든 이슈에 영구 workflow-active 라벨을 남기는 것을 멈춘다. 백로그와 GitHub 화면에서 신호가 사라진다.

## 전략 권고
- 정보 구조를 '저장소 → 탭'에서 '미션 컨트롤 우선'으로 뒤집는다. 최상위 화면 셋은 (1) Inbox: 모든 저장소에서 내 결정이 필요한 것, 실패, 실행 중, 최근 완료 (2) Run 상세: 단계 타임라인, 실시간 로그, diff, CI, 리뷰 판정 (3) Approval: merge 전 승인, 수정 요청, 거부다. 기존 Board, Queue, Settings는 저장소 하위 보조 화면으로 내린다.
- '안전한 첫 실행'을 제품의 핵심 기능으로 다룬다. mao init과 GUI 온보딩 체크리스트, 연결 테스트, 기본 수동 진행, merge gate, '테스트 저장소에서 첫 작업' 가이드를 갖춘다. 목표는 처음 10분 안에 사고 없이 성공 경험 1회를 주는 것이다.
- CLI를 GUI와 동등한 1급 인터페이스로 만든다. 변경 명령은 큐만 바꾸고, 실행은 단일 runner가 맡고, 관찰은 `workflow show --follow`로 한다. 모든 명령에 --json, 명확한 종료 코드, `mao doctor`를 갖추고 npm에 배포한다.
- 엔진 기능(중지, 판정 파싱, 승인 대기 상태, 스트리밍 출력)과 UI를 한 세트로 설계한다. 현재 UI에 표시할 데이터 자체가 없으므로 화면만 만들면 빈 껍데기가 된다.
- 문서를 Diátaxis(tutorial, how-to, reference, explanation)와 ADR 구조로 세우고, 커뮤니티 기본 요건(SECURITY, CONTRIBUTING, CoC, CHANGELOG, topics, 구체적인 설명, 스크린샷)을 갖춘다. 0 stars 상태에서 가장 싸고 효과가 큰 투자다.

## 로드맵 입력
- (now) 안전 기본값: 저장소 추가 시 autoTrigger off, autoAdvance off 또는 merge gate 기본, auto-trigger를 켤 때 'N개 이슈 enqueue' 확인 대화상자 — 첫 실행에서 무인 머지가 일어날 수 있는 critical 위험을 가장 적은 코드로 줄인다.
- (now) 작업 cancel/remove(engine AbortSignal, 프로세스 그룹 종료, 'cancelled' 상태)와 GUI Stop 버튼, `mao workflow cancel|rm` — 개입 흐름의 가장 기본 동작이 없다.
- (now) CLI 변경 명령을 엔진 실행 없는 큐 변경으로 바꾸기, 단일 runner 잠금, `workflow show --follow` — enqueue가 큐 전체를 출력 없이 실행하고 GUI와 중복 실행하는 문제를 막는다.
- (now) `mao init`과 `mao doctor`, GUI 온보딩 체크리스트, provider와 토큰 Test 버튼(ai:run 재사용), set-token의 stdin/gh auth 지원 — 첫 성공까지의 경로를 만들고 토큰이 argv로 노출되는 문제를 없앤다.
- (now) README 재작성, docs/quickstart·safety·providers·troubleshooting, SECURITY·CONTRIBUTING·CoC·CHANGELOG, 저장소 설명과 topics, #1 닫기 — community profile 57%에서 벗어나고, 사람이 따라 할 수 있는 유일한 경로를 만든다.
- (next) 미션 컨트롤: 저장소 간 Inbox, Run 타임라인(스트리밍 로그, diff, CI, 리뷰 판정), merge 전 Approval 패널, OS 알림과 배지 — 관찰과 승인 흐름이 없어 maker-checker 가치가 사용자에게 보이지 않는다.
- (next) 전용 Recovery 화면(GitHub 자동 대조표, 오류 코드, 문서 링크)과 workflow-active 라벨 수명주기 정리 — 현재 복구 안내는 길고 따를 수 없으며, 근거로 삼는 라벨 신호가 쓸모없다.
- (next) 릴리스 채널 기반 업데이트, CLI npm 배포, 버전 주입, #100 마크다운 렌더링, 접근성 기초(탭, 모달, live region, reduced motion) — 배포, 가독성, 접근성의 기본 요건이다.
- (later) 실행 이력과 비용 분석(단계별 소요 시간, 토큰/비용, provider별 성공률), #97 다국어(문구 축약 이후), docs 사이트, ADR 정착 — 핵심 흐름이 안정된 뒤에야 비교와 최적화 화면이 의미를 가진다.
- (later) #96 커밋 그래프, #102 연결선, 추가 디자인 프리셋, 커뮤니티 확장(Discussions, good-first-issue) — 외관과 커뮤니티 확장은 실사용자가 생긴 뒤에 투자 대비 효과가 난다.

## 유지보수자 질문
- 목표 사용자가 메인테이너 본인(개인 도구)인가요, 외부 공개 사용자인가요? 답에 따라 안전 기본값, 배포, 문서 투자 수준이 크게 달라집니다.
- WorkflowEngine(단일 패스, 판정 없음)과 swarm(수정 루프, 리뷰어 판정) 중 어느 쪽이 장기적으로 주력 파이프라인인가요? PR #107이 swarm을 TS로 옮긴 뒤 GUI의 Queue/미션 컨트롤이 swarm을 표시해야 하는지 확인이 필요합니다.
- GUI와 CLI 중 1차 인터페이스는 무엇인가요? `mao run`(cron)과 GUI를 같은 데이터 디렉터리에서 동시에 쓰는 사용 방식을 지원할 생각인가요?
- 공개 저장소에 auto-trigger를 켜는 사용 사례를 지원할 의도가 있나요? 그렇다면 작성자 허용 목록과 이슈 본문 지시문(parseProviderOverride)의 권한 정책을 UI에서 어떻게 보여 줄지 정해야 합니다.
- 언어 정책을 어떻게 정할까요? 공개 인터페이스는 영어로 하고 이슈만 한국어를 허용할지, 한국어를 1차 언어로 둘지 정해 주세요.
- npm 배포(package.json "private": true 해제)와 코드 서명(Apple/Windows) 계획이 있나요?
