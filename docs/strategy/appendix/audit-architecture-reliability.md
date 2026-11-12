# 감사 원자료: 아키텍처 · 신뢰성

> 2026-11-12, `origin/main` `ac0915e` 기준. 하위 에이전트가 저장소를 읽기 전용으로 검토해 낸 결과를 편집 없이 실었습니다.
> 일부 세부(줄 번호 등)는 이슈를 작성하면서 정정했습니다. 어긋나면 이슈 본문과 [project-review-2026-11.md](../project-review-2026-11.md)가 우선합니다.
> 본문의 "코디네이터가 확인한 사실 1~6"은 그 문서 2절의 1, 2, 3, 6, 7, 8·13번 행에 해당합니다.
> 확신 표기: verified(코드를 읽어 확인), likely(추정), speculative(가설).

## 방향성 판정: needs-major-course-correction
core/ 하나를 GUI와 CLI가 공유하는 구조, maker-checker 선택 로직(core/agent-selection.ts)을 렌더러와 엔진이 같이 쓰는 점, Octokit 타임아웃과 422 멱등 처리(#37, #38)는 방향이 맞습니다. 문제는 신뢰성 투자를 어디에 했느냐입니다. 10월에 머지한 PR 7개(#66 #69 #77 #90 #93 #94 #101, 추가 약 15.2k줄)는 config.json이 손으로 편집되거나 두 프로세스가 동시에 쓰는 경우를 막는 데 썼습니다. 실제로 피해가 큰 고장 모드는 그대로입니다. (1) 스테이지 도중 프로세스가 죽으면 'running'이 'pending'으로 돌아가 GitHub 부작용을 다시 실행합니다(workflow-engine.ts:519). (2) 저장소마다 clone 하나를 공유하는데 reset을 하지 않고, 고아 에이전트 프로세스도 정리하지 않습니다(git-workspace.ts:122-126, cli-provider.ts:70-78). (3) 전역 single-flight 큐가 head-of-line blocking을 일으킵니다(workflow-engine.ts:707-733). (4) merge 직전 검사와 실제 merge 사이에 TOCTOU 창이 있습니다(github-service.ts:480,503-505). 저장 계층은 2,359줄(store.ts 1849, store-file.ts 420, persistence-guard.ts 90)로 불어났고, store.ts만 봐도 794줄이 주석입니다. 엔진에는 assertQueueWritable 호출이 31곳 박혀 있습니다. 같은 손상 형태를 하나씩 더 막는 패치를 멈추고 SQLite 큐와 단계별 저널로 저장 모델을 바꾸면, 이 부채를 갚으면서 위 고장 모드도 함께 해결할 수 있습니다. swarm TS 포팅(PR #107)에는 worktree, 프로세스 그룹, registry라는 올바른 기본 부품이 이미 있으므로 두 엔진을 하나로 합치는 것이 다음 18개월의 핵심 결정입니다.

## 강점
- core/가 Electron에 의존하지 않고 createMaoApp() 하나로만 부팅합니다(core/app.ts:161). 그래서 GUI와 CLI가 같은 엔진, 같은 가드를 씁니다. 저장소를 교체할 때도 바꿀 지점이 한 곳뿐입니다.
- GitHub 쓰기 일부가 이미 멱등입니다. createBranch와 createPullRequest의 422 'already exists'를 재사용으로 처리합니다(github-service.ts:364-383, 435-443, #37/#38). 단계별 저널을 붙일 기반이 있습니다.
- FileStore가 tmp 파일 작성, fsync, rename 순서로 원자 교체를 합니다(store-file.ts:365-403, store.ts:1789). 교차 프로세스 쓰기 잠금도 있습니다(#101). 그래서 지금 JSON이 토막 나서 손상될 위험은 낮습니다.
- Octokit 요청마다 60초 deadline을 걸고(github-service.ts:14, 208-210), 영구 권한 실패와 일시적 rate limit을 구분합니다(github-service.ts:165-186). 재시도 정책을 붙이기 좋은 분류입니다.
- PR #107(core/swarm/registry.ts:77-107)은 detached 프로세스 그룹, process.kill(-pid), 작업별 worktree를 구현했습니다. WorkflowEngine에 그대로 가져다 쓸 수 있는 프로세스 감독 부품입니다.
- maker-checker 선택 규칙을 core/agent-selection.ts에 한 번만 정의하고 렌더러 미리보기와 엔진 실행이 같이 씁니다. 규칙이 중복되지 않습니다.

## 발견
### 1. 프로세스가 죽으면 'running'이 'pending'으로 바뀌어 멱등이 아닌 GitHub 부작용을 다시 실행함 (crash consistency 부재)
- 종류/심각도/노력/시점/확신: bug / critical / M / now / verified
- 근거: workflow-engine.ts:750에서 스테이지에 들어갈 때 'running'을 저장합니다. restore()는 이를 'pending'으로 바꿉니다(workflow-engine.ts:519). 그런데 task.github.prNumber/issueNumber는 메모리에서만 갱신되고(891-893, 910-911, 938-940), 디스크에는 스테이지가 끝날 때 notifyAfterStage(813)에서만 반영됩니다. 반면 createIssue(909), reviewPullRequest(946), commentOnIssue(960)에는 중복 방지가 없습니다. mergePullRequest(github-service.ts:503-505)는 이미 merged인지 확인하지 않습니다. mao run은 SIGINT를 받으면 곧바로 process.exit(0)을 호출합니다(cli/index.ts:536-540). SIGTERM 핸들러는 없고, Electron 종료 시 진행 중인 스테이지를 마무리하는 처리도 없습니다(electron/main.ts:45-48). persistence-broken marker(#76, PR #103)는 '쓰기 실패'만 다루고 '쓰기 전에 죽은 경우'는 다루지 않습니다.
- 권고: 고장 모드 표에 따른 현재 동작과 권장 동작입니다. (a) issue 스테이지 중 사망 시 현재는 이슈가 중복 생성됩니다. 본문에 '<!-- mao-task:<taskId> -->' 마커를 넣고, 생성 전에 search로 기존 이슈를 찾습니다. (b) PR 생성 직후 사망 시 현재는 15분짜리 에이전트를 다시 돌리고 push --force로 덮어씁니다. 외부 쓰기마다 바로 step checkpoint(task.github.* 저장)를 남깁니다. (c) merge 직후 사망 시 현재는 merge API가 실패해 task가 영구 error가 되고 요약 코멘트도 사라집니다. merge 전에 pulls.get().merged를 확인해 이미 merged면 성공으로 처리합니다. (d) review도 마커로 중복을 막습니다. 부팅할 때는 'running'을 바로 'pending'으로 돌리지 말고 'interrupted' 상태로 둔 뒤, reconcile 단계에서 GitHub 상태를 조회해 이어서 진행합니다. mao run에는 SIGINT/SIGTERM 그레이스풀 종료를 넣습니다. 신규 수락을 멈추고 현재 스테이지를 최대 N초 기다린 뒤, 넘으면 프로세스 그룹을 kill하고 interrupted로 기록합니다.
- 기존 커버리지: 부분 커버만 있습니다. #37/#38은 branch/PR/merge-comment 재시도만 멱등으로 만들었고, #76/PR #103은 쓰기 실패 marker만 다룹니다. 크래시 후 재실행 문제를 다루는 이슈는 없습니다.

### 2. 공유 clone의 dirty tree가 다음 작업 PR로 섞여 들어가고, 타임아웃이나 종료 때 에이전트 손자 프로세스가 고아로 남음
- 종류/심각도/노력/시점/확신: risk / high / M / now / verified
- 근거: checkoutBranch는 'git checkout base', 'git pull', 'checkout -B'만 실행하고 reset/clean을 하지 않습니다(git-workspace.ts:122-126). commitAndPush는 git add -A 후 push --force를 합니다(133-145). 그래서 앞 작업이 남긴 수정 파일과 untracked 파일이 다음 작업 브랜치로 옮겨 붙고 그대로 커밋됩니다. clone은 저장소당 하나입니다(98-100). CliProvider는 detached 없이 spawn합니다(cli-provider.ts:70). 타임아웃 때 직계 자식에게만 SIGKILL을 보내고(78) 곧바로 settle하므로, 엔진은 다음 task의 checkout을 진행하고 claude/codex가 띄운 하위 프로세스는 같은 디렉터리를 계속 수정합니다. 에이전트가 직접 commit하면 hasChanges(128-131)가 false가 되어 notes-only PR로 빠지고 작업이 사라집니다. clone은 정리되지 않으므로 디스크 사용량이 계속 늘어납니다.
- 권고: 작업마다 '<workspaces>/<owner>__<repo>.git' bare mirror 하나에 'git worktree add <workspaces>/<repo>/<taskId> -B <branch> origin/<base>'로 독립 작업 디렉터리를 만듭니다. 끝나면 'git worktree remove --force'와 'worktree prune'을 실행합니다. 커밋 판정은 status가 아니라 'git rev-list origin/<base>..HEAD' 결과와 status를 합쳐서 합니다. 자식은 detached:true로 띄우고 process.kill(-pid,'SIGTERM'), 유예 후 SIGKILL을 보냅니다. PR #107의 core/swarm/registry.ts(terminateProcessGroups)를 core/process-supervisor.ts로 승격해 두 엔진이 같이 씁니다. Electron 'before-quit'와 mao run 시그널 핸들러에서 supervisor.killAll()을 호출합니다.
- 기존 커버리지: 없음. WorkflowEngine에는 대응책이 없습니다. swarm용 기본 부품만 PR #107(draft)에 있습니다.

### 3. October store 하드닝이 갚은 것은 손상 형태의 긴 꼬리였고, 핵심 위험은 남아 있음
- 종류/심각도/노력/시점/확신: debt / high / S / now / verified
- 근거: PR #66 +1882, #69 +3093, #77 +1688, #90 +1659, #93 +1394, #94 +2288, #101 +3205로 합계 약 15.2k줄이 추가됐습니다(all-prs.tsv). 다룬 위협은 배열이 아닌 githubRepos, 잘못된 원소, 읽을 수 없는 파일, stale snapshot, 동시 writer입니다. 비용은 store.ts 1849줄(그중 주석 794줄, 43%), store-file.ts 420줄, persistence-guard.ts 90줄, store.test.ts 2640줄입니다. 엔진에 assertQueueWritable 호출 31곳, auto-trigger에 polling 가드 9곳이 들어갔습니다(grep -c). 그런데도 열린 후속 이슈가 계속 나옵니다(#76, #81, #91, #112, PR #103).
- 권고: 저장 계층 패치를 지금 동결합니다. #112, #81, #91은 개별로 고치지 말고 아래 저장소 교체 결정(SQLite와 secrets 분리)의 수용 기준으로 묶습니다. 교체가 끝나면 store.ts의 shape 진단 경로와 queue recovery latch, persistence-broken marker, 31곳의 await 사이 가드를 'DB 트랜잭션 + step 저널' 하나로 대체하고 삭제합니다. 삭제 목표는 소스 약 1,800줄과 테스트 약 2,500줄입니다.
- 기존 커버리지: 없음. 오히려 #112, #76/PR #103이 같은 방향으로 꼬리를 더 늘리고 있습니다.

### 4. secrets, 설정, 큐, 실행 이력을 config.json 하나에 담고 stage 전이마다 fsync로 통째로 다시 씀
- 종류/심각도/노력/시점/확신: risk / high / L / now / verified
- 근거: MaoStoreSchema 하나에 githubToken 평문, aiProviders[].apiKey 평문, workflowTasks가 함께 있습니다(store.ts:35-54, 123). 큐에는 history[].prompt/output이 길이 제한 없이 들어갑니다(workflow-engine.ts:789-798, truncation 없음). notify마다 전체 JSON을 직렬화하고 tmp, fsync, rename을 거칩니다(store.ts:1789, store-file.ts:365-403). stage 하나에 최소 3회입니다(750, 772, 813). 쓰기 잠금은 Atomics.wait로 동기 busy-wait를 하므로 Electron main 스레드를 최대 5초 막습니다(store-file.ts:43, 118-119, 286). schemaVersion이 없고, 마이그레이션은 restore()와 read guard 안에서 임시로 처리합니다(workflow-engine.ts:513-520, store.ts:212-244). safeStorage나 keychain 사용 흔적은 grep 결과 0건입니다.
- 권고: 세 갈래로 나눕니다. (1) secrets: Electron safeStorage로 암호화한 blob을 쓰고, CLI는 MAO_GITHUB_TOKEN 환경변수 또는 OS keychain을 씁니다. config에는 참조만 둡니다. (2) settings: settings.json에 schemaVersion과 순서가 있는 migrations[]를 두고 단일 validator로 검사합니다. 작고 드물게 쓰는 파일입니다. (3) 큐와 이력: mao.db(SQLite, WAL, busy_timeout=5000)에 tasks(id, repo, issue_number UNIQUE(repo,issue_number), stage, status, next_attempt_at), steps(task_id, stage, kind, external_ref, done_at), events(task_id, ts, level, msg), outputs(task_id, stage, blob)를 둡니다. 드라이버는 Electron을 Node 22.13+를 번들한 버전으로 올려 node:sqlite를 쓰는 쪽이 좋습니다. 그 전에는 better-sqlite3를 써야 하는데 Electron별 native rebuild가 필요합니다. 마이그레이션 계획입니다. 기존 loadStoredFileStrict()로 config.json을 읽고, 트랜잭션 하나로 import한 뒤 원본을 config.json.v1.bak으로 rename합니다. 한 릴리스 동안 read-only fallback을 유지합니다. 추정 규모는 신규 700-1000줄, 테스트 1.5k줄, 1인 기준 2-3주입니다.
- 기존 커버리지: 없음(#89는 원자 쓰기만 다룸)

### 5. #89(FileStore 원자적 교체)는 이미 코드로 해결됨. 이슈가 stale 상태
- 종류/심각도/노력/시점/확신: process / low / S / now / verified
- 근거: FileStore가 writeStoreFileAtomic(this.filePath, ...)을 호출합니다(store.ts:1789). 이 함수는 'wx'로 tmp 파일을 만들고 fsync 후 renameSync합니다(store-file.ts:365-403). 이 코드는 PR #101(bf72203, 2026-10-31)에서 들어왔습니다. 그런데 gh issue view 89는 OPEN, 코멘트 0개입니다. 또 v0.1.1 마일스톤 항목이므로 release.yml의 '마지막 항목이 닫히면 릴리스' 조건을 막고 있습니다.
- 권고: #89를 PR #101 참조와 함께 닫습니다. electron-store(conf) 쪽 쓰기도 원자적인지(conf는 write-file-atomic을 씀) 한 줄 확인해 기록합니다. #80처럼 이미 해소된 항목도 마일스톤에서 정리해 v0.1.1을 막는 요소를 줄입니다.
- 기존 커버리지: #89 (열려 있으나 이미 해결됨)

### 6. 전역 single-flight 큐가 저장소 사이에 head-of-line blocking을 일으키고, CI pending은 error로 처리됨
- 종류/심각도/노력/시점/확신: risk / high / M / next / verified
- 근거: processQueue에서 processing 플래그 하나로 모든 task를 순차 실행합니다(workflow-engine.ts:707-733). CLI 타임아웃은 15분(cli-provider.ts:25)이고, git 연산도 하나당 15분입니다(git-workspace.ts:10). 이론상 code-edit 스테이지 하나가 1시간을 넘을 수 있습니다. 그동안 다른 저장소의 모든 task가 대기합니다. merge 단계에서 CI가 pending이면 error를 던지고(955), 자동 재확인이 없어 운영자가 retry를 눌러야 합니다. 대기 중인 pending task 수에는 상한이 없습니다(pruneFinishedTasks는 done/error 50개만 정리, 38, 493-501).
- 권고: scheduler를 분리합니다. repo별 lane(Map<repoKey, Promise>)을 두고 전역 동시성 상한(기본 2, 설정 가능)을 둡니다. 같은 repo 안에서는 직렬로 돌립니다. worktree 격리가 끝나면 repo 안에서도 2개까지 허용합니다. 'waiting' 상태와 next_attempt_at 컬럼을 추가해 CI pending, secondary rate limit(Retry-After), 5xx를 지수 백오프(30s, 1m, 2m … 최대 15m, 최대 N회)로 자동 재시도합니다. 영구 실패(권한, 422 비-멱등)만 error로 둡니다. 전제 조건은 앞의 worktree 격리 항목입니다.
- 기존 커버리지: 없음

### 7. merge TOCTOU: 검사한 head SHA와 실제 merge하는 SHA를 묶지 않음
- 종류/심각도/노력/시점/확신: bug / medium / S / now / verified
- 근거: getChecksStatus는 pulls.get으로 head.sha를 읽고 그 ref의 check를 평가합니다(github-service.ts:480-500). mergePullRequest는 sha 인자 없이 pulls.merge를 호출합니다(503-505). 그 사이에 누가 push하면 검증되지 않은 커밋이 merge됩니다. checks가 'none'이면 바로 merge합니다(workflow-engine.ts:953-958). main에는 branch protection도 없습니다(코디네이터 확인).
- 권고: getChecksStatus가 {status, headSha}를 반환하도록 바꾸고 pulls.merge({ sha: headSha })를 호출합니다. 409(head 변경)는 'waiting'으로 되돌려 다시 검사합니다. 같은 지점에서 merged=true면 성공으로 처리해 멱등성을 확보합니다. 이 변경은 크래시 재실행 항목의 merge 부분과 같은 PR로 묶을 수 있습니다.
- 기존 커버리지: 없음

### 8. auto-trigger 중복 방지가 label 하나에만 의존하고, label 실패를 삼켜서 30초마다 같은 이슈를 다시 enqueue할 수 있음
- 종류/심각도/노력/시점/확신: bug / medium / S / now / verified
- 근거: auto-trigger.ts:113은 workflow-active label만 확인합니다. addLabel 실패는 .catch(() => {})로 무시합니다(130). enqueueFromIssue는 (repo, issueNumber)로 중복을 검사하지 않습니다(workflow-engine.ts:664-687). 기본 poll 주기는 30초입니다(auto-trigger.ts:12). label 쓰기가 일시적으로 실패하면(5xx, secondary rate limit) 다음 poll에서 같은 이슈의 두 번째 task가 생깁니다. code-edit 경로에서는 에이전트가 같은 브랜치를 다시 force-push합니다. listForRepo는 첫 50개만 읽습니다(github-service.ts:217-224).
- 권고: 큐에 UNIQUE(repo, issueNumber) 불변식을 둡니다. 당장은 enqueueFromIssue에서 활성 task가 있으면 no-op으로 처리하고, 나중에는 DB unique index로 강제합니다. label은 UI 힌트로만 씁니다. 폴링에는 ETag 조건부 요청(If-None-Match, 304는 rate limit에 집계되지 않음)과 'since' 커서를 써서 50개 상한과 호출 비용을 함께 줄입니다.
- 기존 커버리지: 없음

### 9. Electron 33(Node 20 번들)은 지원 종료로 추정되고, 렌더러가 신뢰할 수 없는 GitHub 본문을 표시함
- 종류/심각도/노력/시점/확신: risk / high / M / now / likely
- 근거: package.json의 electron은 ^33.2.1, react는 ^18.3.1, vite는 ^6.0.7입니다. Electron은 최신 3개 메이저만 지원하고 약 8주 주기로 릴리스합니다. 33(2024-10) 이후 2026-11까지 대략 8-10개 메이저가 나왔을 것으로 추정되므로 33의 Chromium 보안 패치는 1년 넘게 끊겼을 가능성이 높습니다(정확한 현재 메이저 번호는 불확실). webPreferences는 기본값(contextIsolation, sandbox)에 의존하고 CSP가 없습니다(electron/main.ts grep 결과 setWindowOpenHandler만 있음). #100은 마크다운 HTML 렌더링을 추가하려 합니다. 또 Electron 33의 Node 20에는 node:sqlite가 없어 저장소 교체 결정과 묶입니다.
- 권고: #100보다 먼저 지원되는 Electron 메이저로 올리고, index.html에 엄격한 CSP(script-src 'self')를 넣습니다. 그 뒤 node:sqlite를 쓸 수 있습니다. React 19와 Vite 7 이상은 급하지 않으므로 Electron 업그레이드 이후 한 번에 처리합니다. Renovate나 Dependabot을 'electron' 메이저만 자동 PR로 받게 설정합니다.
- 기존 커버리지: 없음

### 10. 두 개의 오케스트레이션 엔진이 서로 다른 신뢰성 모델을 갖고 있음 (WorkflowEngine과 swarm)
- 종류/심각도/노력/시점/확신: risk / medium / L / next / verified
- 근거: WorkflowEngine은 verdict 파싱, revision loop, worktree, 프로세스 그룹이 모두 없습니다(코디네이터 확인 2, workflow-engine.ts:944-962). PR #107의 TS swarm은 작업별 worktree(core/swarm/engine.ts:522), detached 프로세스 그룹(542, 250), 별도 상태 파일 .agents/.process_registry.json(146), 리뷰 문구 정규식(40-42)을 갖고 있습니다. 상태 저장소가 config.json, marker 파일, process_registry.json으로 세 갈래입니다. PR #107은 +3582/-10632로 Python 5,073줄을 TS 약 1,650줄로 줄입니다.
- 권고: #107을 merge한 뒤 다음을 결정합니다. '파이프라인 정의(stages, gate, revision policy)'와 '실행 기반(worktree, supervisor, registry, ForgeClient)'을 분리합니다. 그러면 WorkflowEngine과 swarm은 같은 실행 기반 위에서 돌아가는 서로 다른 파이프라인 설정이 됩니다. review 단계는 구조화된 verdict(JSON 블록 또는 GitHub APPROVE/REQUEST_CHANGES)를 내고, merge gate는 이 verdict를 필수로 요구합니다. registry 상태도 같은 mao.db로 옮깁니다.
- 기존 커버리지: #105/PR #107(포팅만 하고 엔진 통합은 하지 않음)

### 11. 관측성 부재: 로그가 사라지고, 출력은 버퍼링만 하며, 이력은 50개 상한이고, 렌더러는 2초마다 큐 전체를 폴링함
- 종류/심각도/노력/시점/확신: gap / medium / M / next / verified
- 근거: console.warn은 패키지 앱에서 운영자가 볼 수 없습니다(electron/ipc.ts:43-46 주석이 직접 인정). CLI 출력은 끝날 때까지 메모리에 모아 둡니다(cli-provider.ts:89-94). 15분짜리 실행의 진행 상황을 볼 수 없고 stderr도 무제한으로 쌓입니다. 완료 task는 50개만 남깁니다(workflow-engine.ts:38). 렌더러는 WorkflowQueue.tsx:259와 KanbanBoard.tsx:297에서 2초마다 prompt/output을 포함한 큐 전체를 IPC로 받습니다. AGENTS.md 규칙 6('Pulled rather than pushed')이 이 구조를 강제합니다. 메트릭과 알림은 없습니다.
- 권고: task별 events 테이블(또는 JSONL)에 stage 시작/끝, 소요 시간, exit code, stderr tail 4KB를 기록합니다. CLI stdout은 스트리밍하면서 링버퍼 64KB만 메모리에 둡니다. 렌더러에는 'workflow:changed' 이벤트를 push하고(webContents.send, 페이로드는 id/status만), 상세는 on-demand로 pull합니다. error나 persistence 정지가 발생하면 OS 알림을 띄웁니다. 이력은 개수 상한 대신 기간(예: 90일)으로 보존하고 output blob은 별도 테이블에 둡니다.
- 기존 커버리지: 없음

### 12. 수작업 IPC lockstep을 AST 파싱 테스트로 방어함: 우연적 복잡도
- 종류/심각도/노력/시점/확신: debt / medium / S / next / verified
- 근거: AGENTS.md:146-193 설명에 따르면 채널 하나를 추가할 때 electron/ipc.ts, electron/preload.ts, src/electron.d.ts 세 파일을 손으로 맞춰야 합니다. 이를 지키려고 TypeScript AST를 읽는 src/electron-ipc-surface.test.ts(729줄)가 있습니다. 문서는 이 테스트를 지키는 규칙만 약 50줄입니다.
- 권고: core/ipc-contract.ts에 `const contract = { workflow: { retry: (id: string, o?: RunOverride) => QueuedTask, ... } }` 형태의 단일 타입 맵을 둡니다. preload는 Object.keys 루프로 bridge를 생성하고, main은 같은 맵으로 handler를 등록합니다. 채널 문자열은 `${ns}:${method}`로 파생합니다. 그러면 오타가 구조적으로 불가능해지므로 AST 테스트와 AGENTS.md의 해당 절을 삭제합니다.
- 기존 커버리지: 없음

### 13. 크로스 플랫폼 가정: Windows 바이너리를 배포하지만 Windows에서 실행 경로를 검증하지 않음
- 종류/심각도/노력/시점/확신: risk / medium / S / next / likely
- 근거: package.json build.win target은 zip이고 release.yml:138-144 matrix에 windows-latest가 있습니다. 반면 ci.yml:10은 ubuntu-latest에서만 테스트합니다. cli-provider.ts:45는 command.split('/')로 명령 이름을 판별하므로 Windows 경로 구분자와 .cmd shim(npm 전역 설치 claude.cmd)을 놓칩니다. shell:false로 spawn하면 .cmd를 실행하지 못합니다(70). PR #107 swarm은 'isolated POSIX process groups'를 요구합니다(core/swarm/engine.ts:250). process.kill(-pid)는 Windows에서 동작하지 않습니다.
- 권고: 선택지는 둘입니다. (a) README와 릴리스에서 Windows 에이전트 실행을 '미지원'으로 명시하고 win 타깃을 내립니다. (b) ci.yml에 windows-latest를 추가하고, path.basename/path.parse 판별, cross-spawn 또는 shell 경로, Windows용 'taskkill /T /F' supervisor 분기를 넣습니다. 1인 유지보수 규모라면 (a)를 권합니다.
- 기존 커버리지: 없음

## 중단할 것
- config.json 손상 형태를 하나 더 막는 PR(#112, #81, #91 같은 유형)을 그만 만드십시오. 저장소 교체 결정 전까지 동결하고, 이 항목들은 교체 작업의 수용 기준으로 흡수하십시오.
- await마다 assertQueueWritable()을 끼워 넣는 패턴(workflow-engine.ts에 31곳)을 그만두십시오. 트랜잭션과 step 저널로 대체해야 할 증상입니다.
- 설계를 장문 주석과 AGENTS.md 산문으로 방어하는 일(store.ts 주석 43%, AGENTS.md 105KB)을 그만두십시오. 불변식은 타입, DB 제약, 테스트로 표현하십시오.
- 수작업 lockstep을 AST 파싱 테스트로 지키는 방식(electron-ipc-surface.test.ts)을 그만두고 단일 계약 객체에서 파생하십시오.
- WorkflowEngine과 swarm에 신뢰성 기능(worktree, 프로세스 kill, 리뷰 판정)을 따로따로 구현하지 마십시오.
- 리뷰 verdict와 크래시 멱등성이 없는 상태에서 무인 auto-trigger(autoAdvance 기본 true)를 '제품 기본 동작'으로 홍보하거나 확장하지 마십시오.
- Electron 업그레이드 없이 렌더러에 HTML 렌더링(#100) 같은 공격 표면을 추가하지 마십시오.

## 전략 권고
- 결정 1. 저장 모델을 secrets(safeStorage/keychain), settings.json(schemaVersion + migrations), mao.db(SQLite WAL: tasks/steps/events/outputs)로 나눕니다. 마이그레이션은 기존 loadStoredFileStrict()로 읽고 트랜잭션 하나로 import한 뒤 config.json.v1.bak으로 보존합니다. 한 릴리스 동안 read-only fallback을 둡니다. 위험: native 모듈(better-sqlite3)을 쓰면 Electron 메이저마다 rebuild가 필요하므로 Electron을 먼저 올려 node:sqlite를 쓰는 편이 좋습니다. 기대 효과는 store 계층 약 1,800줄과 테스트 약 2,500줄 삭제, 동시 writer와 원자성 문제를 SQLite에 위임하는 것입니다.
- 결정 2. 실행 의미론을 'at-least-once + 단계별 멱등'으로 명시합니다. 외부 쓰기는 모두 (lookup-before-create, 결과를 steps 테이블에 기록) 쌍으로 구현하고, 부팅 시 'running'을 'interrupted'로 바꾼 뒤 reconcile합니다. 마이그레이션 순서는 issue/review/merge 멱등화(마커와 merged 확인), step checkpoint, reconcile 순입니다. 위험: GitHub search API의 인덱싱 지연이 있으므로 마커 검색 대신 'issues?creator=@me&labels=' 같은 직접 조회와 함께 씁니다.
- 결정 3. 작업 격리와 프로세스 감독을 공용 부품으로 만듭니다. bare mirror에 작업별 git worktree를 두고, detached 프로세스 그룹 supervisor는 PR #107 registry.ts에서 승격합니다. 종료 경로(SIGINT/SIGTERM/before-quit)에서 반드시 killAll을 호출하고, 완료 후 worktree를 제거하고 prune합니다. 위험: Windows에서는 프로세스 그룹 의미론이 다르므로 지원 범위를 먼저 결정해야 합니다.
- 결정 4. 스케줄러를 repo별 lane, 전역 동시성 상한, 'waiting'+next_attempt_at 백오프로 바꿉니다. CI pending, secondary rate limit, 5xx를 자동 재시도로 흡수합니다. 결정 3이 끝난 뒤에 진행합니다.
- 결정 5. 파이프라인 정의를 데이터로 둡니다. stages[], gate(verdict 필수), revision policy를 실행 기반과 분리하고, WorkflowEngine과 swarm을 같은 실행 기반 위의 두 설정으로 수렴시킵니다. #1(model/effort pinning)과 '설정 가능한 스테이지'는 이 위에서 구현합니다. 위험: 큰 리팩터링이므로 #107 merge 직후 짧은 설계 문서 한 장으로 범위를 고정합니다.
- 결정 6. 확장 지점은 TaskSource(GitHub Issues/폴링/웹훅)와 ForgeClient(createIssue, openPR, review, merge, checks) 두 인터페이스만 둡니다. GitHubService가 첫 구현입니다. 다른 VCS 호스트는 later로 미루되, 인터페이스는 결정 2의 멱등 계약(lookup-before-create)을 포함해야 합니다.
- 결정 7. 플랫폼 위생 정책입니다. Electron은 지원되는 3개 메이저 안에 머무르고, CSP를 적용합니다. IPC는 단일 계약 객체로 정의하고, 렌더러에 변경 이벤트를 push(id/status)하고 상세는 pull합니다. 규칙 6(poll-only)을 '데이터는 pull, 신호는 push'로 완화합니다.
- 고장 모드 요약표(고장, 가능성, 영향 범위, 현재 동작 → 권장 동작)입니다. (1) issue 단계 중 사망: 중간, 이슈 중복, 재실행 → 마커 조회. (2) PR 생성 후 사망: 중간, 에이전트 재실행과 force-push → step checkpoint. (3) merge 후 사망: 낮음~중간, task 영구 error와 요약 코멘트 유실 → merged 확인. (4) CLI 타임아웃: 높음, 고아 프로세스가 공유 clone 수정 → 그룹 kill과 worktree. (5) 앞 task의 dirty tree: 높음, 다른 PR에 엉뚱한 변경 포함 → 작업별 worktree. (6) 15분 스테이지: 높음, 모든 repo 정지 → repo lane. (7) CI pending: 높음, 수동 retry 필요 → waiting+백오프. (8) label 쓰기 실패: 낮음, 중복 task → UNIQUE 키. (9) 검사와 merge 사이 push: 낮음, 미검증 코드 merge → sha 고정. (10) 잠금 경합: 낮음, Electron UI 최대 5초 정지 → SQLite busy_timeout을 워커 쪽에서 처리.

## 로드맵 입력
- (now) 크래시 멱등화 묶음: issue/review 마커 조회, merge 전 merged 확인과 sha 고정, enqueueFromIssue 중복 방지, mao run SIGINT/SIGTERM 그레이스풀 종료 — 무인 auto-trigger가 GitHub에 중복 쓰기를 하거나 영구 error를 만드는 가장 가능성 높은 경로이고, 각각 S 규모입니다.
- (now) 작업별 git worktree와 프로세스 그룹 supervisor 공용화(PR #107 registry 승격) — dirty tree가 섞이고 고아 에이전트가 남는 문제는 실행 결과의 정확성을 직접 훼손합니다. 동시성의 전제 조건이기도 합니다.
- (now) store 패치 동결, #89 닫기, Electron 메이저 업그레이드와 CSP — 이미 해결된 이슈가 v0.1.1 릴리스를 막고 있습니다. Electron 업그레이드는 보안 문제이고 node:sqlite를 쓰기 위한 전제이기도 합니다.
- (now) 저장소 분리 설계와 구현: secrets는 safeStorage, settings.json은 schemaVersion, 큐는 mao.db(SQLite) — 15k줄짜리 방어 코드를 1k줄 미만으로 대체하고, step 저널과 이력 보존의 기반을 만듭니다.
- (next) 스케줄러: repo별 lane, 동시성 상한, waiting/백오프, ETag 조건부 폴링 — head-of-line blocking과 CI pending 수동 retry를 없애고, 등록 저장소가 늘어도 rate limit 여유를 확보합니다.
- (next) WorkflowEngine과 swarm 수렴: 파이프라인 정의를 데이터로, review verdict gate 필수, revision loop — maker-checker라는 제품 약속을 실제로 집행하는 유일한 방법이고, 신뢰성 코드의 중복을 없앱니다.
- (next) 관측성: task events, 스트리밍 출력 링버퍼, push 알림, 기간 기반 이력 보존 — 15분짜리 블랙박스 실행과 사라지는 경고 때문에 운영자가 고장을 진단할 수 없습니다.
- (later) TaskSource/ForgeClient 추상화와 GitLab/Gitea 같은 두 번째 구현, 웹훅 기반 트리거 — 다른 VCS 호스트와 작업 소스로 확장하는 로드맵은 멱등 계약이 정착된 뒤에야 안전합니다.
- (later) Windows 정식 지원 여부 재결정(CI matrix, taskkill 기반 supervisor) — 사용자 수요가 확인될 때까지는 미지원을 명시하는 편이 1인 유지보수에 맞습니다.

## 유지보수자 질문
- 10월 store 하드닝의 계기가 실제 사용자 config.json 손상 사례였습니까, 아니면 리뷰에서 도출한 이론적 위협 모델이었습니까? 실제 사례가 없다면 저장소 교체와 동결이 더 정당화됩니다.
- GUI와 mao run(CLI)이 같은 config.json에 동시에 붙는 운용이 필수 시나리오입니까? 그렇다면 SQLite WAL이 지금의 동기 lock보다 확실히 낫고, 아니라면 단일 writer 프로세스로 단순화할 수 있습니다.
- 장기적으로 제품의 핵심 엔진은 WorkflowEngine(GUI 큐)입니까, swarm입니까? 수렴 방향을 정하는 데 필요합니다.
- Electron 33에 머물러 있는 구체적 이유(호환성, 빌드, 서명)가 있습니까?
- Windows 사용자가 실제로 있습니까? 없다면 win 타깃을 내리는 데 동의하십니까?
- auto-trigger의 autoAdvance 기본값 true로 실제 무인 merge까지 운용한 저장소가 있습니까? 크래시 멱등화의 우선순위를 정하는 데 필요합니다.
