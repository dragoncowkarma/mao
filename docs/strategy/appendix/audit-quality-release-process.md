# 감사 원자료: QA · 릴리스 · 개발 프로세스

> 2026-11-12, `origin/main` `ac0915e` 기준. 하위 에이전트가 저장소를 읽기 전용으로 검토해 낸 결과를 편집 없이 실었습니다.
> 일부 세부(줄 번호 등)는 이슈를 작성하면서 정정했습니다. 어긋나면 이슈 본문과 [project-review-2026-11.md](../project-review-2026-11.md)가 우선합니다.
> 본문의 "코디네이터가 확인한 사실 1~6"은 그 문서 2절의 1, 2, 3, 6, 7, 8·13번 행에 해당합니다.
> 확신 표기: verified(코드를 읽어 확인), likely(추정), speculative(가설).

## 방향성 판정: needs-major-course-correction
품질 투자가 엉뚱한 위험에 몰려 있습니다. 10월 머지 11건 중 7건(약 +15k줄)이 단일 사용자 로컬 config.json 손상 대비에 쓰였고, 그 사이 AGENTS.md는 55KB에서 105KB로, core/store.ts는 17.5KB에서 100KB로 커졌습니다(git cat-file -s, b208de4 → bf72203). 반면 제품의 핵심 약속인 "다른 AI가 리뷰하고 통과해야 머지한다"는 리뷰 프롬프트에 제목만 들어가고 리뷰 결과와 무관하게 머지되는 상태로 남아 있습니다. 이를 증명하는 테스트도, 실제 CLI나 GitHub를 쓰는 e2e도 없습니다. 릴리스 쪽에서는 v0.1.0 이후 커밋 191개가 출시되지 않았습니다(다운로드 0). v0.1.1 마일스톤은 12건 open, 0건 closed이고, 사용자 가치가 없는 테스트 부채와 문서 이슈가 릴리스를 막고 있습니다. MAO 자체 파이프라인으로 만든 PR(workflow/* 브랜치)은 8월 3~6일의 3건이 마지막입니다. 그래서 dogfooding 증거도 없습니다. 고칠 대상은 코드 품질보다 위험 판단과 운영 규칙입니다. 하드닝을 동결하고, 머지 게이트에 대한 hermetic e2e를 만들고, 시간 기반 릴리스 트레인으로 바꿔야 합니다.

## 강점
- CI(.github/workflows/ci.yml)가 모든 PR에서 tsc, vitest(core/renderer 분리), Python, check-origin, vite build를 실행합니다. 1인 프로젝트로서는 기본기가 좋습니다.
- release.yml이 잘 만들어져 있습니다. target_sha를 고정하고, 빌드 전에 verify를 다시 돌리고, 기존 릴리스를 확인해 중복을 막습니다(멱등). concurrency group도 있어 재실행해도 안전합니다.
- vitest.config.ts는 core를 plain Node로 강제하고 renderer는 jsdom으로 분리했습니다. 타임아웃을 정한 근거까지 주석으로 남겼습니다. core/가 Electron에 의존하지 않아 hermetic e2e의 토대가 이미 있습니다.
- GithubService 생성자가 fetch를 주입받습니다(core/github-service.ts:198-210). 이미 가짜 GitHub 서버를 붙일 수 있는 이음매가 있습니다.
- PR #107의 scripts/test-swarm-bundle.mjs는 소스 트리, Python, 네트워크 없이 PATH에 둔 가짜 gh/codex/git으로 번들을 검증합니다. 목표 e2e의 원형이 이미 저장소 안에 있습니다.
- PR 본문과 리뷰 대응이 정직합니다. 예를 들어 #69에서 작성자가 과장된 주장을 스스로 철회했습니다. 뮤테이션으로 테스트가 실제로 결함을 잡는지 확인하는 문화(SKILL.md:826-828)도 있습니다.

## 발견
### 1. 10월 하드닝의 범위 폭주: 비배열 githubRepos 하나를 막으려던 작업이 프로세스 간 원자성 프로젝트로 커졌습니다
- 종류/심각도/노력/시점/확신: process / critical / S / now / verified
- 근거: 10월 머지 11건 중 7건(#66 #69 #77 #90 #93 #94 #101)이 store 관련이고 추가량 합계는 약 +15k줄입니다. 출발점인 #60은 비배열 githubRepos 처리였습니다. PR #69에는 리뷰 라운드가 5번 이상(코멘트 12개) 있었고, 쟁점은 단일 사용자 데스크톱 앱의 config.json을 두고 '다른 OS 프로세스가 compare와 write 사이에 복구하는 경우'였습니다. 작성자 코멘트(2026-10-04): '같은 종류의 주장을 세 번 과장했습니다'. 그 결과 core/store-file.ts:193 createStoreWriteLock, setIfUnchanged, latch 상태 기계가 생겼습니다. git cat-file -s 기준 AGENTS.md는 55,206에서 104,916바이트로, core/store.ts는 17,572에서 100,623바이트로 커졌습니다(b208de4 → bf72203). 같은 기간 마지막 사용자 기능은 #54(9/8)이었고, 리뷰 프롬프트가 제목만 담는 문제(workflow-engine.ts:125-136)와 리뷰 결과를 무시한 머지(950-962)는 그대로입니다.
- 권고: store 하드닝을 당장 동결합니다. 위협 모델을 '한 데이터 디렉터리에는 한 프로세스'로 문서화하고, 두 번째 인스턴스는 pid lockfile로 부팅을 거부하게 합니다. 그러면 프로세스 간 경합 시나리오가 전부 범위 밖이 됩니다. 남은 store 이슈(#76 #81 #91 #112)는 각각 1일로 타임박스하고, 넘으면 ADR 한 장으로 '하지 않음'을 결정합니다. 앞으로는 하드닝 이슈를 열 때 '실제 사용자가 겪었는가, 아니면 리뷰어가 상상했는가'를 필수 필드로 적게 합니다.
- 기존 커버리지: none (오히려 #76 #81 #89 #91 #112가 같은 방향으로 더 확장 중)

### 2. 테스트 1.8만 줄이 핵심 약속(리뷰가 머지를 막는다)을 증명하지 않고, 실제 CLI·GitHub 경로는 무검증입니다
- 종류/심각도/노력/시점/확신: gap / critical / L / now / verified
- 근거: core/workflow-engine.test.ts:139,166,195는 CI 체크 상태에 따른 머지만 검증합니다. 리뷰 판정과 머지의 관계를 다루는 테스트는 없고, 지금 동작(체크가 success/none이면 머지)이 사실상 고정돼 있습니다. core/ai/cli-provider.test.ts는 node -e로 4개 케이스만 확인하고, 실제 claude/codex 플래그(--effort 일괄 추가 등)는 검증하지 않습니다. api-provider.ts에는 테스트가 없습니다. scripts/test-workflow.ts는 CI 밖에 있고, 작업이 error로 끝나도 exit 0입니다. 이 문제는 고치지 않고 SKILL.md:717-720에 '함정'으로만 적어 두었습니다. electron/main.ts, ipc.ts, 패키징된 앱, config 업그레이드(v0.1.0 형식의 config.json을 현재 코드로 읽는 경우)도 테스트하지 않습니다.
- 권고: 이음매 2개를 추가해 hermetic e2e를 만듭니다. (1) GithubService에 주입되는 fetch를 인메모리 가짜 GitHub(issues/pulls/reviews/checks/merge 상태 저장)로 바꿉니다. (2) git-workspace.ts:103의 하드코딩된 github.com remote를 MAO_GIT_REMOTE_BASE 환경변수로 file:// bare repo에 연결할 수 있게 합니다. 가짜 claude/codex 실행 파일은 #107의 test-swarm-bundle.mjs 패턴을 재사용해 argv와 stdin을 기록하고 정해진 응답을 내게 합니다. 첫 시나리오 5개는 이렇습니다. 리뷰가 거절하면 머지되지 않음(지금은 실패해야 정상), 리뷰 프롬프트에 diff와 PR 번호가 포함됨, 같은 provider는 연속 stage를 맡지 않음, 비협업자가 만든 이슈는 자동 enqueue되지 않음, v0.1.0 config fixture로 부팅함. test-workflow.ts는 error면 exit 1로 바꿉니다(2줄 수정).
- 기존 커버리지: none (#83은 수집 경로만 다룸, PR #107은 swarm 번들 smoke만)

### 3. 릴리스 트레인이 멈췄습니다: v0.1.1이 12/0 상태로 묶였고, 191커밋이 미출시이며, 이미 해결된 이슈가 릴리스를 막고 있습니다
- 종류/심각도/노력/시점/확신: process / high / S / now / verified
- 근거: gh api milestones 결과는 'v0.1.1 open=12 closed=0 due=null'입니다. git rev-list --count v0.1.0..origin/main은 191입니다. 유일한 릴리스 v0.1.0의 asset 4개는 다운로드 0입니다. release.yml은 open_issues가 0이어야만 배포합니다. v0.1.1에는 사용자가 체감하지 못하는 항목이 6개 있습니다(#64 #86 #87 Python 테스트, #82 #83 테스트 인프라, #80 문서). #89(원자적 교체)는 #101에서 이미 구현됐습니다(core/store-file.ts:365 writeStoreFileAtomic, 379 wx 임시 파일, 403 renameSync). 그런데 이슈는 열려 있어 릴리스를 막습니다.
- 권고: #89를 #101 참조와 함께 닫습니다. #64 #80 #82 #83 #86 #87은 'quality-backlog' 라벨로 옮기고 마일스톤에서 뺍니다. 그다음 v0.1.1을 이번 주에 출시합니다. 이후에는 범위가 아니라 날짜로 정하는 2주 릴리스 트레인으로 갑니다. release.yml에 schedule 트리거를 두거나, 마일스톤마다 due_on을 강제하고 마감일에 남은 이슈를 다음 마일스톤으로 넘기는 스크립트를 추가합니다. 마일스톤에는 사용자에게 보이는 변경만 넣습니다.
- 기존 커버리지: none

### 4. 패키징된 앱의 self-update가 거짓 신호를 냅니다: main이 움직이면 '새 버전'이 뜨고, Restart는 같은 바이너리를 재시작할 뿐입니다
- 종류/심각도/노력/시점/확신: bug / high / S / now / verified
- 근거: core/self-update.ts:16-40은 빌드 SHA(vite.config.ts:7-15에서 git rev-parse HEAD로 얻음)를 dragoncowkarma/mao main의 HEAD와 비교합니다. electron/ipc.ts:50-53의 app:relaunch는 app.relaunch() 후 app.quit()만 실행하고 아무것도 내려받지 않습니다. 릴리스 빌드는 마일스톤 SHA로 고정되므로, 그 뒤 main에 머지가 하나만 들어가도 모든 설치본에 'New version available'이 뜨고(UpdateBanner.tsx), Restart를 눌러도 변화가 없습니다. 원래 #26은 소스에서 실행하는 경우를 위한 설계였습니다. package.json build에는 publish/auto-update provider가 없습니다.
- 권고: 단기: app.isPackaged이면 main HEAD 대신 최신 GitHub Release 태그를 package version과 비교하고, 버튼을 'Restart'에서 '다운로드 페이지 열기'로 바꿉니다. 소스 실행일 때만 지금 동작을 유지합니다. 중기: macOS 서명/공증이 준비되면 electron-updater와 GitHub provider로 전환합니다.
- 기존 커버리지: none

### 5. CI는 실제로 출시하는 산출물(CLI 번들, Electron 패키지, macOS/Windows)을 빌드하지 않습니다
- 종류/심각도/노력/시점/확신: gap / high / M / now / likely
- 근거: ci.yml은 ubuntu 단일 job에서 npm ci, lint, test, test:origin, vite build만 실행합니다. build:cli와 electron-builder는 release.yml에서만 돌기 때문에, 패키징 실패는 마일스톤이 닫히는 순간에야 드러납니다. PR #107이 build:cli와 bundle smoke를 추가하지만 아직 draft입니다. Windows에서는 core/ai/cli-provider.ts:70의 spawn(command, ..., { shell: false })가 npm으로 설치한 .cmd shim(codex.cmd 등)을 실행하지 못할 가능성이 큽니다. Node가 CVE-2024-27980 대응 이후 .cmd/.bat를 shell 없이 spawn하면 EINVAL을 냅니다. win32 분기는 core/cli/electron을 통틀어 3곳뿐입니다.
- 권고: ci.yml에 build:cli와 `node dist-cli/index.cjs --help` smoke를 지금 추가합니다(#107과 별개로 1줄). electron/, package.json, vite.config.ts가 바뀌는 PR에서는 paths 필터로 macos/windows matrix의 electron-builder --dir smoke를 돌립니다. Windows CLI provider는 실행 파일 확장자를 해석해 처리하고(또는 cross-spawn 사용), .cmd shim을 대상으로 하는 테스트를 windows runner에서 돌립니다.
- 기존 커버리지: PR #107 (draft): build:cli와 test:swarm-bundle을 CI에 추가, 패키징과 OS matrix는 none

### 6. 자기 제품을 자기 개발에 쓰지 않습니다: MAO 파이프라인이 만든 PR은 8월 6일 이후 0건입니다
- 종류/심각도/노력/시점/확신: process / high / M / now / likely
- 근거: 엔진은 workflow/<n>-<slug> 브랜치를 만듭니다(core/workflow-engine.ts:854,918). all-prs.tsv에서 이 브랜치로 만든 PR은 #8 #16 #17(2026-08-03~06) 3건뿐입니다. 이후 PR 45건은 claude/*(17개 브랜치)와 codex/*(4개)로, 외부 AI 도구 세션에서 나왔습니다. 그런데 open 이슈 23건 전부에 auto-trigger가 붙이는 workflow-active 라벨이 있습니다. 파이프라인이 이슈를 집어 갔지만 결과물이 채택되지 않았다는 뜻으로 보입니다.
- 권고: 'MAO가 만든 머지 PR 비율'을 핵심 지표로 정합니다. 목표는 v0.2.0 시점 30%입니다. 리뷰 stage에 diff를 넣고 판정을 파싱해 머지를 막는 작업을 먼저 하고, 그다음 이 저장소의 작은 버그 이슈를 MAO로만 처리합니다. 실패하면 그 실패가 곧 다음 이슈입니다. workflow-active 라벨 정책(auto-trigger에 author 게이트가 없음)은 dogfooding을 재개하기 전에 정리합니다.
- 기존 커버리지: none

### 7. 같은 이슈를 여러 AI 도구로 중복 구현하는 비용: #72는 세 번 구현됐고, 원격 브랜치 40개와 워크트리 33개가 있습니다
- 종류/심각도/노력/시점/확신: process / high / S / now / verified
- 근거: #72는 #74(+1911), #95(+1358), #93(+1394, 머지) 세 번 구현됐습니다. #60은 #66(머지), #71, #74로, #67은 #70, #90으로 이어졌습니다. 닫힌 PR 코멘트에는 'Superseded by …'와 'branch is kept'가 반복됩니다(#70 #71 #74 #95). git branch -r은 40개, git worktree list는 33개, .claude/worktrees/에는 6개가 있습니다. #69 코멘트의 '독립 설계안들과 적대 검증의 일치된 결론'처럼 한 리뷰 라운드마다 여러 에이전트를 돌립니다.
- 권고: 규칙: 이슈 하나에 구현 PR은 하나입니다. 대안을 탐색해야 하면 diff가 아니라 ADR 초안(1쪽)으로 비교합니다. 동시에 열린 PR은 draft를 포함해 2개를 넘기지 않습니다(지금 7개). 저장소 설정에서 delete_branch_on_merge를 켜고, superseded로 닫힌 브랜치는 7일 뒤 삭제합니다. 워크트리는 주 1회 git worktree prune으로 정리합니다.
- 기존 커버리지: none

### 8. PR 크기가 7배 커졌고 리뷰 라운드에 상한이 없습니다
- 종류/심각도/노력/시점/확신: process / medium / S / now / verified
- 근거: all-prs.tsv에서 머지 PR의 추가 줄 수 중앙값은 8월 231, 9월 940, 10월 1659입니다. #62는 +7606/-507이고 리뷰가 45개입니다. #69는 커밋 21개, 코멘트 12개, 리뷰 라운드 5번 이상이며, 라운드마다 새 P1이 나왔습니다. 리뷰어(유지보수자 계정에서 실행된 다른 AI)가 리뷰 범위를 넓히는 대로 수용했고, 범위를 다시 줄이는 장치가 없습니다.
- 권고: 테스트를 뺀 diff를 400줄로 제한하고 넘으면 분할합니다. 리뷰는 2라운드까지만 하고, 3라운드째 P1은 새 이슈로 떼어 낸 뒤 현재 PR은 머지합니다(fail-closed가 보장되는 경우). 리뷰 지적은 '이 PR이 만든 회귀'와 '기존 결함'으로 나누고, 후자는 반드시 별도 이슈로 보냅니다. PR 템플릿에 이 세 줄을 추가합니다.
- 기존 커버리지: none

### 9. 공급망과 거버넌스: 브랜치 보호, Dependabot, CodeQL, 서명이 모두 없습니다
- 종류/심각도/노력/시점/확신: risk / high / M / now / likely
- 근거: .github/에는 ISSUE_TEMPLATE, pull_request_template.md, workflows(ci, release)만 있고 dependabot.yml과 codeql은 없습니다. main에는 브랜치 보호가 없습니다(코디네이터 확인). release.yml은 permissions contents: write와 issues: write로 pull_request_target에서 실행되고, actions/*@v4는 태그로 참조합니다(SHA 고정 아님). macOS는 CSC_IDENTITY_AUTO_DISCOVERY=false로 서명 없는 dmg를 만들고, Windows는 서명 없는 zip입니다. electron ^33.2.1은 현재 지원 범위(최신 3개 메이저)를 벗어났을 가능성이 큽니다.
- 권고: 지금: main에 브랜치 보호를 걸고 CI를 필수로 하며 force push를 금지합니다. dependabot.yml(npm, github-actions, 주간 그룹화)을 추가하고, release.yml의 action을 SHA로 고정합니다. CodeQL default setup도 켭니다. 다음: Electron을 지원 메이저로 올리고, release에 `npm sbom --sbom-format cyclonedx` 결과와 SHA256SUMS를 첨부합니다. 나중: Apple Developer ID 서명과 공증을 붙이고, Windows는 Azure Trusted Signing을 검토합니다.
- 기존 커버리지: none

### 10. `mao --version`이 하드코딩돼 있어 릴리스 버전과 어긋납니다
- 종류/심각도/노력/시점/확신: bug / medium / S / now / verified
- 근거: cli/index.ts:75는 .version('0.1.0')입니다. release.yml build-cli는 `npm version ${VERSION}`으로 package.json만 바꾸고, esbuild 번들(scripts/build-cli.mjs)에는 버전을 주입하지 않습니다. 따라서 v0.1.1 CLI 번들도 0.1.0을 출력합니다. main의 package.json도 계속 0.1.0이라, 소스 빌드에서 버전을 구분할 수 없습니다.
- 권고: build-cli.mjs에서 esbuild define으로 __MAO_VERSION__을 package.json 값과 git describe 결과로 주입합니다. release.yml build-cli 단계에 `node dist-cli/index.cjs --version | grep -qx "$VERSION"` 검증을 추가합니다.
- 기존 커버리지: none

### 11. 수동 뮤테이션 관행과 Python 테스트 부채: #107이 머지되면 #64, #86, #87은 무의미해집니다
- 종류/심각도/노력/시점/확신: debt / medium / M / next / verified
- 근거: SKILL.md:826-828은 PR마다 어떤 뮤테이션을 돌렸는지 적게 합니다. #63 #64 #86 #87은 swarm_orchestrator_test.py(5184줄)의 뮤테이션 공백을 다룹니다. PR #107은 Python 파일과 테스트를 삭제하고, 본문에서 #64(8개), #86(4개), #87(10개) 변형 22개를 TypeScript 테스트로 잡았다고 밝힙니다. 다만 'Refs'일 뿐 'Closes'는 아닙니다. #82(의존 방향 규칙)와 #83(cli/·electron/ 테스트 수집)은 각각 수십 줄짜리 작업입니다.
- 권고: #107이 머지되면 #64, #86, #87을 함께 닫습니다(지금 Python에 투자하지 않습니다). #83은 vitest.config.ts에 cli/electron 프로젝트를 추가하는 것으로 30분 안에 처리하고, #82는 core/** import를 훑는 테스트 하나로 처리합니다. 둘 다 릴리스 차단 항목이 아닙니다. 수동 뮤테이션은 PR마다 하지 말고, 위험 1등급 모듈(workflow-engine 머지 게이트, agent-selection, auto-trigger, repo-capabilities, git-workspace)에 한해 Stryker를 주간 스케줄로 돌리고 survived 개수만 추세로 봅니다.
- 기존 커버리지: #64 #82 #83 #86 #87, PR #107

### 12. 정적 품질 게이트가 tsc 하나뿐입니다(ESLint/Biome, 포매터, 커버리지 없음)
- 종류/심각도/노력/시점/확신: gap / medium / S / next / verified
- 근거: package.json의 "lint"는 "tsc --noEmit"입니다. SKILL.md 리뷰 체크리스트에는 'there is no autoformatter'라고 적혀 있습니다. vitest.config.ts에는 coverage 설정이 없습니다. 그래서 floating promise, 미처리 rejection, 의도치 않은 any 같은 결함은 사람(AI 리뷰어)의 읽기에 의존합니다. 이번 리뷰 라운드 폭주의 일부가 이것 때문입니다.
- 권고: Biome을 도입해 lint와 format을 한 번에 처리합니다. 기존 위반은 baseline으로 두고 신규만 막습니다. 비동기 결함은 typescript-eslint의 no-floating-promises 하나만 별도로 켭니다. 커버리지는 @vitest/coverage-v8로 보고만 하고, 게이트는 위험 1등급 파일의 branch 커버리지 하락 금지 정도로만 둡니다. 전체 % 목표는 두지 않습니다.
- 기존 커버리지: none

### 13. 배포 채널이 GitHub Release의 tar/zip뿐입니다: 헤드리스 CLI가 실제 채택 경로인데 설치 경로가 없습니다
- 종류/심각도/노력/시점/확신: opportunity / medium / M / next / likely
- 근거: package.json은 "private": true라 npm에 publish할 수 없습니다. release.yml은 CLI를 index.cjs와 swarm_orchestrator.py를 묶은 tar.gz/zip으로 냅니다. 사용자가 Python을 따로 준비해야 하는데, #107이 머지되면 이 의존이 사라지고 단일 cjs가 됩니다. Homebrew, Docker, GitHub Action, npx 경로는 없습니다. 데스크톱 앱은 서명 없는 dmg로, Gatekeeper가 막습니다.
- 권고: 사용자 가치 순서는 다음과 같습니다. (1) #107 머지 후 npm에 `@<scope>/mao` CLI를 publish합니다. provenance(--provenance, OIDC)를 붙여 `npx mao run`이 되게 합니다. (2) 헤드리스 상시 실행용 Docker 이미지를 만듭니다(node:22-slim, gh, git, 비루트, GHCR). (3) GitHub Action 래퍼를 만듭니다. 이슈 라벨 트리거로 한 번만 실행하는 방식이면 상시 polling이 필요 없습니다. (4) Homebrew tap을 만듭니다. (5) 서명과 자동 업데이트가 붙은 데스크톱 앱. 데스크톱 서명 비용은 사용자가 확인된 뒤에 씁니다.
- 기존 커버리지: PR #107이 단일 번들의 전제 조건

### 14. 이슈 #1은 코드로 이미 해결됐는데 v0.2.0 마일스톤에 열려 있습니다
- 종류/심각도/노력/시점/확신: process / low / S / now / likely
- 근거: #1의 요구는 per-task model/effort pin, 그리고 이슈 본문으로 provider를 지정하는 것입니다. core/ai/types.ts:62,84에는 effort와 run override가 있고, core/agent-selection.ts:48-74에는 ProviderOverride, 역할별 pin, 일회성 override가 있습니다. core/assignment.ts:20-36은 [Model:]/[Effort:] 태그를 파싱합니다. 머지된 PR은 #8, #10, #43('Parse [Model:]/[Effort:] directives … (#1)'), #54입니다.
- 권고: 남은 차이가 있으면 새 이슈로 범위를 좁히고 #1은 닫습니다. 마일스톤 정리 시 '코드에 이미 있는가'를 확인하는 단계를 둡니다. 이런 일이 두 번째(#89 포함)입니다.
- 기존 커버리지: #1, PR #8 #10 #43 #54

## 중단할 것
- store/config.json 하드닝을 멈춥니다. 단일 인스턴스 lockfile 하나로 프로세스 간 경합을 범위에서 빼고, 남은 store 이슈는 1일 타임박스 또는 ADR로 정리합니다.
- 같은 이슈를 Claude, Codex 등 여러 도구로 병렬 구현한 뒤 하나만 고르는 방식을 멈춥니다. 대안 비교는 diff가 아니라 1쪽 ADR로 합니다.
- 리뷰어 AI가 리뷰 라운드마다 범위를 넓히는 것을 그대로 받아들이지 않습니다. 3라운드째 지적은 새 이슈로 보냅니다.
- 버그를 AGENTS.md나 SKILL.md에 '함정'으로 적는 것으로 대신하지 않습니다(예: test-workflow.ts exit 0). 2줄짜리 수정이면 고칩니다.
- AGENTS.md에 사건 기록식 상세 설명을 계속 쌓지 않습니다. 105KB는 에이전트 컨텍스트 비용이자 리뷰 범위 폭주의 연료입니다. 규칙과 사례는 분리합니다(#110 방향은 맞습니다).
- 사용자 가치가 없는 테스트 부채와 문서 이슈를 릴리스 마일스톤에 넣어 릴리스를 막지 않습니다.
- Python swarm 테스트(#64 #86 #87)에 더 투자하지 않습니다. #107이 대체합니다.

## 전략 권고
- 위험 등급표를 도입합니다. 1등급(정지선): GitHub에 쓰거나 머지하는 경로입니다. 리뷰 판정 게이트(workflow-engine.ts:950-962), auto-trigger의 author 게이트(auto-trigger.ts:108-130), 토큰을 remote URL에 넣는 것과 push --force(git-workspace.ts:101-145), provider 권한 플래그가 해당합니다. hermetic e2e 시나리오와 사람의 최종 확인이 필수입니다. 2등급: 로컬 데이터 손실입니다. 원자적 교체는 이미 됐으니 단위 테스트로 충분합니다. 3등급: UI/UX입니다. renderer 테스트 1개면 됩니다. 4등급: 문서와 테스트 인프라입니다. 릴리스를 막지 않습니다.
- 목표 테스트 전략(피라미드)은 이렇습니다. (a) core 단위 테스트는 지금 수준을 유지하되 신규 store 테스트는 동결합니다. (b) 계약 테스트를 추가합니다. 실제 claude/codex `--help` 출력 스냅샷으로 플래그 존재를 검증하는 주간 job을 두고, 깨지면 이슈를 자동 생성합니다. (c) hermetic e2e는 가짜 GitHub(fetch 주입), file:// bare remote, PATH의 가짜 provider CLI로 구성하고 PR마다 1분 이내로 돌립니다. (d) 실제 sandbox 저장소 e2e는 scripts/test-workflow.ts를 exit code가 맞게 고친 뒤 workflow_dispatch와 주간 스케줄로만 돌리고, secrets는 environment로 보호합니다. (e) 패키징 smoke로 OS matrix에서 electron-builder --dir와 CLI --version을 확인합니다.
- 품질 게이트(필수 체크)는 tsc, Biome, vitest(core/renderer/cli/electron), e2e-hermetic, build:cli와 --version 검증으로 구성합니다. electron/package.json이 바뀔 때는 패키징 smoke를 추가합니다. 커버리지와 Stryker는 보고만 하고 게이트로 쓰지 않습니다.
- 시간 기반 릴리스 트레인으로 바꿉니다. 격주 화요일에 그 시점 main을 출시하고, 마일스톤은 날짜로 정하며, 남은 이슈는 자동으로 다음 마일스톤에 넘깁니다. release.yml은 schedule이나 workflow_dispatch 기반으로 바꾸고, 마일스톤 완료 트리거는 보조로만 둡니다. 생성된 릴리스 노트에는 사용자 영향 섹션을 사람이 한 단락 붙입니다.
- 운영 규칙: 동시에 열린 PR 2개 이하, 테스트 제외 diff 400줄 이하, 리뷰 2라운드 상한, 이슈당 구현 PR 1개, 하드닝 1일 타임박스, 범위를 넓히거나 줄이는 결정은 docs/adr/NNNN-*.md 1쪽으로 남깁니다.
- 주간 지표 6개를 봅니다. 마지막 릴리스 후 경과 일수(목표 14 이하), PR 리드타임 중앙값, PR 크기 중앙값, 열린 PR 수, MAO 파이프라인이 만든 머지 PR 비율, PR당 리뷰 라운드 수. 하나의 이슈(issue-metrics 액션 또는 gh 스크립트)에 자동으로 기록합니다.
- 매몰 비용은 인정합니다. 10월의 +15k줄은 되돌리지 말고 동결하되, 그 위에 더 쌓지 않습니다. 다음 3개월은 리뷰가 머지를 실제로 막는 제품을 만들고, 그것을 이 저장소에서 증명하는 데 씁니다.

## 로드맵 입력
- (now) v0.1.1을 즉시 출시합니다. #89와 #1을 닫고 비사용자 항목 6개를 마일스톤에서 빼며, cli/index.ts 버전을 주입하고, 패키징된 앱의 self-update를 릴리스 태그 기준으로 고칩니다. — 191커밋이 출시되지 않았고 다운로드는 0입니다. 피드백 루프가 아예 없습니다.
- (now) main 브랜치 보호(CI 필수), Dependabot(npm, actions), action SHA 고정, CodeQL, CI에 build:cli와 --version smoke 추가 — 1인 저장소에서도 AI 에이전트가 push하므로 마지막 방어선이 필요합니다. 비용은 반나절입니다.
- (now) hermetic e2e 하네스: 가짜 GitHub(fetch 주입), MAO_GIT_REMOTE_BASE, PATH 가짜 provider로 1등급 시나리오 5개 — 리뷰가 머지를 막는다는 핵심 약속을 증명할 수단이 지금은 없습니다. 리뷰 stage 수정의 선행 조건입니다.
- (now) store 하드닝 동결 ADR, 단일 인스턴스 lockfile, WIP/PR 크기/리뷰 라운드 규칙을 PR 템플릿과 AGENTS.md 상단에 명시 — 10월처럼 범위가 폭주하는 일이 반복되지 않게 합니다.
- (next) #107 머지 후 npm publish(provenance), GHCR Docker 이미지, Python 테스트 이슈 3건 종료 — 헤드리스 CLI가 실제 채택 경로입니다. 단일 번들이 되면 배포 비용이 크게 줄어듭니다.
- (next) OS matrix 패키징 smoke, Windows CLI provider(.cmd shim) 수정, 실제 provider CLI 플래그 계약 테스트(주간) — Windows와 macOS 산출물을 한 번도 실행 검증하지 않은 채 출시하고 있습니다.
- (next) Biome, no-floating-promises, 커버리지 보고, 위험 1등급 모듈의 주간 Stryker — 수동 뮤테이션과 AI 리뷰에 기대던 품질 보증을 자동화하고 상한을 둡니다.
- (later) macOS 서명/공증, Windows 서명, electron-updater 자동 업데이트, Homebrew tap, GitHub Action 배포 — 사용자 수요가 확인된 뒤에 써야 하는 고정비입니다.
- (later) 실제 sandbox 저장소 대상의 야간 e2e(실제 claude/codex 1회 실행, 비용 상한)와 dogfooding 비율 대시보드 — 외부 CLI와 GitHub의 행동 변화를 조기에 감지하고, 제품 가치를 수치로 증명합니다.

## 유지보수자 질문
- MAO 파이프라인(workflow/* 브랜치)으로 이 저장소의 이슈를 처리하는 것을 8월 이후 중단한 이유가 무엇인가요? 결과물 품질 때문인가요, 리뷰 stage 신뢰 문제인가요, 아니면 auto-trigger가 모든 이슈에 workflow-active를 붙이는 부작용 때문인가요?
- 같은 config.json을 두 프로세스(예: GUI와 mao run)가 동시에 쓰는 시나리오를 실제 사용자 또는 본인이 겪은 적이 있나요, 아니면 리뷰에서 나온 가정인가요? 답에 따라 단일 인스턴스 lockfile로 범위를 닫을 수 있는지가 결정됩니다.
- v0.1.1 마일스톤에 테스트 부채와 문서 이슈를 넣은 것은 의도적인 '품질 게이트'였나요? release.yml이 이 마일스톤을 릴리스 트리거로 쓴다는 점을 고려한 설계였나요?
- 주 사용 형태가 데스크톱 GUI인가요, 헤드리스 CLI인가요? 서명과 공증 예산을 쓸지, npm/Docker를 먼저 할지가 이 답에 달려 있습니다.
- PR #107은 언제 draft를 해제할 계획인가요? 머지 후 #64, #86, #87을 닫는 데 동의하시나요?
- 유지보수자의 두 계정이 각각 어떤 역할(사람과 에이전트, 리뷰어와 작성자)을 하나요? 브랜치 보호에서 필수 리뷰어를 둘지 결정하는 데 필요합니다.
