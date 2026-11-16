# 감사 원자료: 제품 전략 · AI 에이전트 시스템

> 2026-11-12, `origin/main` `ac0915e` 기준. 하위 에이전트가 저장소를 읽기 전용으로 검토해 낸 결과를 편집 없이 실었습니다.
> 일부 세부(줄 번호 등)는 이슈를 작성하면서 정정했습니다. 어긋나면 이슈 본문과 [project-review-2026-11.md](../project-review-2026-11.md)가 우선합니다.
> 본문의 "코디네이터가 확인한 사실 1~6"은 그 문서 2절의 1, 2, 3, 6, 7, 8·13번 행에 해당합니다.
> 확신 표기: verified(코드를 읽어 확인), likely(추정), speculative(가설).

## 방향성 판정: needs-major-course-correction
MAO가 내세우는 가치는 "다른 AI가 검증한 PR만 머지된다"(README.md:5, :9)입니다. 그런데 GUI와 CLI가 쓰는 WorkflowEngine의 핵심 루프는 이 약속을 지키지 못합니다. review 단계는 제목 한 문장만 받습니다. 게다가 CliProvider의 시스템 프롬프트(core/ai/cli-provider.ts:4-8)가 "no tool calls ... no commentary about the working directory or repository"라고 지시해서 diff를 보는 일 자체를 금지합니다. merge는 리뷰 내용과 상관없이 CI가 "none"이어도 진행됩니다. API provider를 쓰거나 에이전트가 아무것도 편집하지 않으면 workflow-notes/*.md만 담긴 PR이 기본 브랜치에 자동 머지됩니다(workflow-engine.ts:895-898, 917-943). 반면 Swarm에는 이미 좋은 설계가 있습니다. 역할 태그, 신뢰 코멘트 필터, revision 루프, provider cooldown, 벤더 패밀리 구분이 그것이고 PR #107에서는 Reviewer diff 주입까지 들어갔습니다. 대신 판정을 산문 regex로 하고 머지를 LLM에게 맡깁니다. 지난 두 달 동안 투입은 저장소 손상 하드닝(10월 머지 11건 중 7건)과 UI(v0.2.0 마일스톤 5건 중 4건, PR #109 +1544줄)에 집중됐고 하네스 품질은 9월 8일 이후 손대지 않았습니다. 메인테이너 본인도 MAO로 MAO를 만들지 않습니다(PR 61건 중 claude/ 브랜치 34건, workflow/ 3건은 모두 8월 초). 방향 자체(교차 벤더 maker-checker)는 옳습니다. 다만 다음 3개월은 UI와 하드닝을 멈추고 두 엔진을 하나의 파이프라인으로 합쳐야 합니다. 이 파이프라인은 컨텍스트를 충분히 담은 프롬프트, diff와 체크아웃을 보는 구조화 판정, 결정론적 머지 게이트, 테스트 실행 검증을 갖춰야 합니다.

## 강점
- agent-selection.ts는 Node 의존이 없는 순수 함수라 renderer와 엔진이 같은 maker-checker 규칙을 공유합니다(agent-selection.ts:4-13). one-shot 선택이 금지되면 조용히 바꾸지 않고 큰 소리로 실패시키는 설계(resolveOneShotProvider, :124-152)도 운영자 신뢰 측면에서 옳습니다.
- assignment.ts는 코드 펜스, 인라인 코드, HTML 주석, 인용문을 먼저 제거하고 태그를 파싱합니다(assignment.ts:83-88). 문서에 예시로 적힌 태그가 지시로 오인되지 않으며, last-occurrence-wins 후 검증하는 순서도 정확합니다.
- Swarm의 EXECUTION_INTEGRITY_NOTICE(swarm_orchestrator.py:3287-3312)는 실제로 관찰한 실패 모드에서 나왔습니다. 단발 배치 프로세스가 '나중에 이어서 하겠다'며 종료하는 경우와 push 실패를 성공으로 보고하는 경우입니다. 하네스 엔지니어링 감각이 좋습니다.
- Swarm은 PR 코멘트를 OWNER/COLLABORATOR/MEMBER나 오케스트레이터 사용자 것만 신뢰합니다(swarm_orchestrator.py:4517-4523). DEFAULT_ROTATION으로 세 역할을 서로 다른 벤더 패밀리에 배정하고(:151-155), quota와 rate-limit 패턴을 감지해 cooldown합니다(:87-98). WorkflowEngine에 없는 것들이 여기 이미 있습니다.
- PR #107은 Reviewer diff 주입, 부정·조건부 승인 판정, codex용 -c model_reasoning_effort, 최신 모델 카탈로그를 담았고 변형 22개로 경계 테스트 뮤테이션 검증을 했습니다. 엔진 수렴의 출발점으로 충분합니다.
- 모든 실행 경로가 runStage 하나로 모이고 그 앞에서 assertRepoWorkflowWritable를 거칩니다(workflow-engine.ts:752-760). 외부 쓰기 전에 권한을 확인하는 단일 관문이라 하네스를 고칠 때 손댈 지점이 명확합니다.

## 발견
### 1. WorkflowEngine의 review와 merge는 검증 흉내에 그침: 리뷰어가 diff를 볼 수 없게 막혀 있음
- 종류/심각도/노력/시점/확신: bug / critical / M / now / verified
- 근거: buildPromptForStage(workflow-engine.ts:125-136)는 제목만 넘깁니다. 비도구 경로에는 DEFAULT_SYSTEM_PROMPT(cli-provider.ts:4-8, 62-66)가 붙는데, 내용이 'no tool calls, no file edits, and no commentary about the working directory or repository'입니다. review 실행에는 cwd도 넘어가지 않습니다(workflow-engine.ts:783-784, cli-provider.ts:70의 options?.cwd가 undefined). 그래서 claude나 codex처럼 도구를 쓸 수 있는 CLI도 PR을 열어볼 수 없습니다. 결과는 COMMENT 이벤트로 게시되고(github-service.ts:457-464), merge는 체크가 success 또는 none이면 진행됩니다(workflow-engine.ts:950-958). 지금 이 파이프라인의 실제 품질은 '구현 에이전트의 무검증 PR이 자동 머지되는 수준'이고, 리뷰 코멘트는 제목을 보고 지어낸 문장입니다.
- 권고: review 단계를 다시 설계해야 합니다. (1) 입력: gh pr diff 결과(PR #107의 reviewerContext처럼 5만 자에서 자르고 잘렸다는 표시를 붙임), PR 본문, 이슈 본문과 수용 기준, 대상 저장소 규약 파일. (2) 실행 위치: PR head를 체크아웃한 읽기 전용 작업 디렉터리. (3) 출력: {verdict: approve|request_changes|block, findings[], tests_run[]} 형식의 JSON 스키마. claude는 --output-format json, codex는 --output-schema나 마지막 메시지의 JSON 블록으로 받습니다. (4) 게시: verdict에 따라 GitHub review 이벤트를 APPROVE나 REQUEST_CHANGES로 매핑합니다. (5) merge 게이트: 오케스트레이터 코드가 최신 head SHA에 대한 approve가 있는지 결정론적으로 확인합니다. 이것이 하네스 개선 1순위입니다.
- 기존 커버리지: none (열린 이슈 없음. PR #107은 Swarm 쪽에만 diff 주입)

### 2. API provider를 쓰거나 에이전트가 아무것도 편집하지 않으면 '구현 노트' 마크다운이 기본 브랜치에 자동 머지됨
- 종류/심각도/노력/시점/확신: bug / critical / S / now / verified
- 근거: usesCodeEdits는 CLI이면서 workspaceRoot가 있을 때만 참입니다(workflow-engine.ts:763). 그 밖의 경우와 에이전트가 변경하지 않은 경우(:895-898)에는 applyGithubAction의 pr 분기가 workflow-notes/<n>.md를 커밋하고 PR을 엽니다(:917-943). auto-trigger는 autoAdvance=true로 큐에 넣으므로(workflow-engine.ts:669, auto-trigger.ts:124) review와 merge가 이어서 실행되고, CI가 없는 저장소라면 노트 파일이 main에 머지됩니다. README.md:15에 'falls back to a notes-only PR'로 적혀 있긴 하지만 그 뒤에 자동 머지된다는 사실은 숨겨져 있습니다. 에이전트가 거절하거나 quota 때문에 빈 출력으로 끝나도 같은 경로를 탑니다.
- 권고: 변경 없음은 실패로 다뤄야 합니다. 상태를 'needs-human'으로 두고 이슈에 사유를 코멘트하며, PR은 열지 않습니다. API provider는 pr 단계 자격에서 빼고 review 전용으로 제한합니다(allowedStages 기본값). notes PR 경로는 삭제합니다.
- 기존 커버리지: none

### 3. maker-checker가 '직전 단계, provider id' 기준이라 PR 작성자가 merge하고, 같은 벤더·모델 두 개로도 통과됨
- 종류/심각도/노력/시점/확신: bug / high / M / now / verified
- 근거: agent-selection.ts:232-236은 previous.agentId 하나만 뺍니다. auto-trigger 태스크는 history가 빈 상태로 stage 'pr'에서 시작하므로(workflow-engine.ts:675-685) provider가 A, B 두 개면 pr=A, review=B, merge=A가 됩니다. 코드를 쓴 A가 머지 단계를 맡는 셈이고, README.md:9의 'no agent reviews or merges its own work'는 사실이 아닙니다. 또 비교 기준이 id라서 같은 claude CLI와 같은 모델로 엔트리를 두 개 등록하면 규칙이 무력화됩니다. 벤더나 모델 패밀리 개념을 표현할 필드도 없습니다(AiProviderConfig에는 providerKindId만 있고 비교에 쓰지 않음). [Model: x] 태그는 태스크 전체에 적용되므로(assignment.ts:139-141, agent-selection.ts:240-243) 모든 단계가 같은 모델로 수렴합니다. 대조적으로 Swarm은 세 역할의 ai 패밀리가 모두 달라야 하고(DEFAULT_ROTATION swarm_orchestrator.py:151-155, validate_distinct_roles), PR #107은 커스텀 agy 이름도 Gemini여야 한다고 강제합니다(models.ts:122). 단일 provider일 때는 조용히 완화됩니다(:236).
- 권고: AiProviderConfig에 family(vendor/model-family, 예: anthropic/opus)를 추가하고 providerKindId와 model에서 기본값을 유도합니다. 규칙은 '이 태스크의 모든 maker(issue/pr 실행자)와 다른 family여야 review/merge를 맡을 수 있다'로 바꿉니다. 직전 단계 비교가 아니라 history 전체를 봅니다. review와 merge에서는 단일 provider 완화를 없애 hard-fail시키고, 명시적 opt-in(allowSelfReview)이 있을 때만 허용합니다. model 태그는 역할별로 바꿉니다([Reviewer: id | Model: m]). 고칠 때까지 README의 보장 문구는 수정합니다.
- 기존 커버리지: #7, #30 (closed — 인접 단계 규칙만 다룸); 열린 이슈 none

### 4. 두 엔진 모두 신뢰할 수 없는 이슈 작성자가 디스패치를 일으키고 역할·모델·effort를 고를 수 있음
- 종류/심각도/노력/시점/확신: risk / high / S / now / verified
- 근거: auto-trigger.ts:120은 작성자 검사 없이 모든 오픈 이슈 본문에서 [Worker:]/[Reviewer:]/[Maintainer:]/[Model:]/[Effort:]를 파싱합니다. 공개 저장소라면 누구든 [Model: opus][Effort: max]로 비용을 키우거나 검증자를 고를 수 있습니다. 이슈 제목은 --dangerously-skip-permissions로 실행되는 에이전트 프롬프트에 그대로 들어가고(workflow-engine.ts:863-876), 그 작업 디렉터리의 remote URL에는 토큰이 박혀 있습니다(검증된 사실 5). Swarm은 코멘트에는 신뢰 필터가 있지만(swarm_orchestrator.py:4517-4523) 이슈는 --json number,title,body로만 가져옵니다(:2481-2491). 그래서 외부인이 '[Task]' 제목에 Worker 태그를 단 이슈를 열면 Worker가 sandbox 우회 상태로(--dangerously-bypass-approvals-and-sandbox, :3403-3407) 이슈 본문을 그대로 실행합니다(:3704).
- 권고: 두 엔진에 같은 신뢰 게이트를 둡니다. 이슈 작성자의 authorAssociation이 OWNER/MEMBER/COLLABORATOR이거나 쓰기 권한자가 'mao:go' 라벨을 붙였을 때만 enqueue와 지시 태그 파싱을 허용합니다. 라벨 이벤트의 actor도 확인합니다. 지시 태그 값은 등록된 provider와 카탈로그 모델 허용 목록 안에서만 받습니다.
- 기존 커버리지: none (코디네이터 사실 4로 지적됨, 이슈 없음)

### 5. 두 엔진을 Swarm 라이프사이클 하나로 수렴하되, 판정과 머지는 결정론적 코드로 옮겨야 함
- 종류/심각도/노력/시점/확신: gap / high / L / next / verified
- 근거: WorkflowEngine은 직선 4단계에 revision 루프가 없고 판정도 파싱하지 않습니다. Swarm(Python, 그리고 PR #107의 core/swarm/engine.ts)은 revision 루프와 신뢰 코멘트가 있지만 약점이 있습니다. (a) 승인 여부를 산문 regex로 판정합니다. 부정·조건부 승인 패턴 목록이 engine.ts:32-47이고 한국어 패턴은 '승인 불가'와 '수정 필요' 정도만 있습니다. (b) 머지를 LLM Maintainer가 gh로 직접 합니다(swarm_orchestrator.py:3984-3986). (c) '읽기 전용' 리뷰어에게 --allowed-tools 'Bash(gh *),Bash(git *),Read'를 줍니다(:3460, models.ts:171). 이 권한으로 gh pr merge와 gh api 쓰기가 가능합니다. (d) 리뷰어 cwd가 PR head가 아니라 repoRoot입니다(:3880, PR #107 engine.ts dispatch cwd=this.repoRoot). 그래서 PR 코드로 테스트를 돌릴 수 없습니다. (e) revision 횟수 상한이 보이지 않습니다. (f) 프롬프트가 'Read AGENTS.md and .agents/rules/'를 전제로 하니 사실상 MAO 저장소 전용입니다.
- 권고: PR #107이 들어간 뒤 core/pipeline 하나를 만듭니다. 상태 기계는 Worker(체크아웃) → Reviewer(PR head 읽기 전용 체크아웃, diff, JSON verdict) → [request_changes면 Worker revise, 최대 N=2회, 초과하면 needs-human] → MergeGate(오케스트레이터 코드: 최신 SHA approve, CI, 검증 결과) → (선택) Maintainer 요약 코멘트입니다. GitHub 코멘트 태그는 사람이 읽기 위한 감사 기록으로만 두고, 상태 원천은 구조화된 verdict로 합니다. GUI와 CLI의 WorkflowEngine 4단계 텍스트 파이프라인은 이 파이프라인의 뷰로 바꾸고 issue 단계는 plan 단계로 대체합니다.
- 기존 커버리지: #105 / PR #107 (draft — 포팅만 하고 수렴은 다루지 않음)

### 6. 컨텍스트 부재: 이슈 본문은 라우팅에만 쓰이고 작업 프롬프트에는 들어가지 않으며, 대상 저장소 규약은 우연히만 전달됨
- 종류/심각도/노력/시점/확신: gap / high / M / now / verified
- 근거: auto-trigger.ts:120은 task.body를 parseProviderOverride에만 씁니다. pr 프롬프트는 제목과 issueUrl뿐입니다(workflow-engine.ts:863-867). 이슈 본문은 어떤 모델을 쓸지는 정하면서 무엇을 만들지는 전달하지 못하는 셈입니다. AGENTS.md, CONTRIBUTING.md, 테스트 명령 같은 대상 저장소 규약을 읽으라는 지시도 없습니다. codex는 AGENTS.md를, claude는 CLAUDE.md를 스스로 읽으니 일부는 우연히 전달되지만 API provider와 review 단계에는 아무것도 가지 않습니다. issue 단계에서 에이전트가 쓴 본문(:908-911)도 pr 프롬프트에 다시 들어가지 않습니다.
- 권고: core/context-pack.ts를 둡니다. 담을 내용은 이슈 본문과 신뢰 코멘트, 링크된 이슈와 PR, 규약 파일(AGENTS.md, CLAUDE.md, CONTRIBUTING.md, .github/pull_request_template.md, 각 수 KB 상한), 감지한 검증 명령(package.json scripts.test/lint, Makefile, .github/workflows의 run 단계), 이전 리뷰 피드백입니다. 모든 역할 프롬프트가 같은 팩을 쓰게 하고 프롬프트 빌더를 순수 함수로 만들어 스냅샷 테스트합니다.
- 기존 커버리지: none

### 7. 검증 단계가 없고, CI가 없으면 'none'으로 통과함
- 종류/심각도/노력/시점/확신: gap / medium / M / next / verified
- 근거: merge는 checksStatus가 pending이나 failure일 때만 막힙니다(workflow-engine.ts:953-956). CI가 없는 저장소(none)는 그대로 머지됩니다. Worker 프롬프트에도 테스트를 돌리라는 지시가 없습니다(:863-867). 개인 저장소 상당수는 CI가 없어서 이 사용자층에서는 'none'이 기본값입니다.
- 권고: Worker에게 감지한 test/lint 명령을 실행하고 결과를 PR 본문의 '검증' 섹션에 남기도록 요구합니다. 오케스트레이터도 깨끗한 체크아웃에서 같은 명령을 직접 돌려(타임아웃, 네트워크 off 옵션) 결과를 MergeGate 입력으로 씁니다. 'none'이면서 로컬 검증도 없으면 자동 머지 대신 needs-human으로 보냅니다.
- 기존 커버리지: none

### 8. 구독 CLI의 quota와 rate limit, 타임아웃이 WorkflowEngine에서 처리되지 않음
- 종류/심각도/노력/시점/확신: gap / medium / M / now / likely
- 근거: CliProvider는 종료 코드 0이 아니면 stderr를 붙여 reject하는 것이 전부이고, quota나 인증, 타임아웃을 구분하지 않습니다(cli-provider.ts:98-105). Swarm에는 PROVIDER_LIMIT_PATTERNS와 1시간 cooldown이 있고(swarm_orchestrator.py:87-98), PR #107의 core/swarm/cooldown.ts는 reset 시각까지 파싱합니다. WorkflowEngine에는 이에 해당하는 것이 없습니다. 실행 타임아웃은 15분 고정이고(cli-provider.ts:25) 직계 자식만 SIGKILL합니다. Swarm은 agy에 45분을 줍니다(:109). CLI가 사용량 한도 메시지를 종료 코드 0으로 출력하면 그 텍스트가 그대로 이슈, PR 노트, 리뷰로 GitHub에 게시될 수 있습니다(추정).
- 권고: PR #107의 cooldown 모듈을 core 공용으로 올려 WorkflowEngine도 씁니다. 실패를 quota, auth, timeout, agent_failure, empty_output으로 분류하고, quota면 해당 provider family를 cooldown한 뒤 다음 family로 넘기거나 대기합니다. 역할별 타임아웃을 설정할 수 있게 하고 프로세스 그룹 전체를 종료합니다. 출력이 비었거나 한도 패턴에 걸리면 GitHub 쓰기를 차단합니다.
- 기존 커버리지: PR #107 (Swarm 한정 cooldown); WorkflowEngine none

### 9. main의 모델 카탈로그가 1년 넘게 낡았고 codex에 존재하지 않는 --effort를 넘김
- 종류/심각도/노력/시점/확신: debt / medium / S / now / verified
- 근거: provider-options.ts:37-66에는 claude-3-7-sonnet, claude-3-5-sonnet, claude-3-opus와 codex용 gpt-4o, o1, gpt-4-turbo가 올라 있습니다. 반면 Swarm은 claude-opus-5와 gpt-5.6-*로 매핑합니다(swarm_orchestrator.py:3334-3372). cli-provider.ts:51-53은 모든 CLI에 --effort를 붙이는데, codex exec는 이 플래그 대신 -c model_reasoning_effort를 씁니다. PR #107의 buildModelEffortArgs와 새 카탈로그가 이 문제를 고치지만, #107은 draft에 +3.5k/-10.6k 규모입니다. API 기본 모델(claude-3-5-sonnet-20241022, gpt-4o)도 같은 문제입니다.
- 권고: PR #107에서 provider-options.ts와 buildModelEffortArgs만 떼어 별도 PR로 지금 머지합니다. 길게 보면 카탈로그를 하드코딩하지 말고 자유 입력을 허용한 뒤 Settings에 'provider 테스트' 버튼(짧은 핑 프롬프트)을 두어 모델과 effort 유효성을 실측합니다. 카탈로그에는 last-verified 날짜를 붙입니다.
- 기존 커버리지: PR #107 (draft), #113, #78

### 10. 관측성 공백: 스트리밍 transcript, 사용량·비용 원장, 에이전트 평가가 모두 없음
- 종류/심각도/노력/시점/확신: gap / medium / L / next / verified
- 근거: CliProvider는 stdout 전체를 버퍼링한 뒤 끝에 한 번 반환합니다(cli-provider.ts:89-105). 15분 동안 GUI에 진행 상황이 보이지 않고 tool call 기록도 남지 않습니다. 토큰과 비용 필드는 history 항목에 없습니다(workflow-engine.ts:789-798). API provider는 단발 호출에 max_tokens 4096입니다(검증된 사실 6). 역할과 모델별 성공률을 잴 장치가 없으니 어떤 조합이 좋은지 데이터로 고를 수 없습니다.
- 권고: 구조화 CLI 어댑터를 만듭니다. claude는 -p --output-format stream-json, codex는 exec --json 이벤트를 파싱해 tool 사용, 최종 메시지, usage, 비용을 추출하고 태스크별 transcript 파일(앱 데이터 디렉터리, config.json과 분리)과 ledger로 남깁니다. 다음으로 평가 하네스를 만듭니다. 픽스처 저장소 하나에 숨겨진 테스트가 있는 시드 이슈 10~20개를 두고, 역할×모델 조합의 해결률, 리뷰 정확도(심어둔 버그 탐지율), 비용을 nightly로 측정합니다.
- 기존 커버리지: none

### 11. issue 단계 결과가 버려지고 plan/spec 단계가 없음
- 종류/심각도/노력/시점/확신: opportunity / medium / M / next / verified
- 근거: issue 단계는 제목으로 이슈 본문을 만들어 GitHub에 올리지만(workflow-engine.ts:908-911), 다음 pr 단계 프롬프트는 제목과 URL만 씁니다(:863-867). 수용 기준이 없으니 리뷰어도 무엇을 기준으로 판정할지 모릅니다. Swarm Maintainer는 후속 이슈에 'acceptance criteria'를 요구합니다(swarm_orchestrator.py:3998-4001). 다만 Worker나 Reviewer가 이를 구조적으로 확인하지는 않습니다.
- 권고: issue 단계를 plan 단계로 바꿉니다. 산출물은 수용 기준 목록, 영향 파일 추정, 검증 명령을 담은 JSON이고 태스크 상태에 저장합니다. Worker 프롬프트와 Reviewer verdict 스키마는 수용 기준별 충족 여부를 필수로 받습니다. 규모가 큰 이슈는 plan 단계에서 split을 제안하고 사람이 승인하게 합니다.
- 기존 커버리지: none

### 12. 도그푸딩 중단: 메인테이너가 8월 이후 MAO로 MAO를 개발하지 않음
- 종류/심각도/노력/시점/확신: process / medium / S / now / likely
- 근거: all-prs.tsv의 head 브랜치 접두어는 claude 34, codex 5, feat 6, fix 5, workflow 3, [PR] 형식(Swarm) 2입니다. WorkflowEngine이 만든 workflow/ PR은 #8, #16, #17로 모두 2026-08-03~06이고, Swarm PR은 #23, #32(8월)입니다. 그 이후 개발은 Claude Code 세션에서 직접 이뤄졌습니다(브랜치 접두어로 추론).
- 권고: 북극성 지표를 'MAO main에 머지된 PR 중 MAO 파이프라인이 만든 비율'로 정합니다. 3개월 안에 30% 이상, 6개월 안에 50% 이상이 목표입니다. 메인테이너가 직접 쓰지 않는 기능은 우선순위를 낮춥니다. 파이프라인이 실패한 사례는 모두 평가 픽스처로 만듭니다.
- 기존 커버리지: none

### 13. v0.2.0 백로그가 핵심 루프와 무관한 UI이고, #1은 이미 해결됨
- 종류/심각도/노력/시점/확신: process / medium / S / now / verified
- 근거: v0.2.0 마일스톤은 #96(커밋 그래프), #97(UI 언어), #100(마크다운 렌더링), #102(연결선)에 #1이 더해진 구성입니다. PR #109(디자인 시스템, +1544), #98, #99도 UI입니다. #1에 남은 범위는 '이슈 본문에서 model/effort 태그를 파싱하는 것'인데, assignment.ts:143-160 parseProviderOverride가 [Model:]과 [Effort:]를 이미 파싱하고 auto-trigger.ts:120이 이를 사용합니다. release.yml은 마일스톤의 마지막 항목이 닫혀야 릴리스하므로, 해결된 #1이 열려 있는 한 릴리스도 막힙니다.
- 권고: #1은 해결된 것으로 닫습니다. v0.2.0을 하네스 마일스톤으로 다시 정의합니다(이 리뷰의 1, 2, 3, 4, 6번 항목). UI 항목 4건은 later로 옮기거나 닫습니다. PR #109는 머지하지 말고 보류합니다. 열려 있는 draft 7건은 2주 안에 각각 머지, 닫기, 보류 중 하나로 결정합니다.
- 기존 커버리지: #1 (resolved by current code), v0.2.0 milestone

## 중단할 것
- UI 기능을 그만 만드세요. 디자인 시스템(PR #109), 커밋 그래프(#96/#98), UI 언어(#97/#99), 연결선(#102), 마크다운 렌더링(#100)은 하네스가 실제로 검증하게 될 때까지 동결합니다.
- 저장소 손상 하드닝은 #89와 #91에서 마무리하세요. 10월에 이미 +15k줄을 썼고, 사용자 0명인 상태에서 남은 위험은 데이터 손상보다 '무검증 자동 머지' 쪽이 훨씬 큽니다.
- 두 엔진을 따로 유지하는 일을 멈추세요. 새 하네스 기능을 WorkflowEngine과 Swarm 양쪽에 각각 넣지 말고, 수렴 설계를 확정한 뒤 한쪽에만 넣습니다.
- README의 'no agent reviews or merges its own work'와 'cross-verification' 문구는 고칠 때까지 내리세요. 지금 코드로는 사실이 아닙니다.
- LLM 판정을 산문 regex로 해석하는 방식을 키우지 마세요. 부정 승인 패턴을 늘릴수록 오탐과 미탐도 같이 늘어납니다. 구조화된 verdict로 바꿉니다.
- 에이전트 규칙을 산문 지시로 계속 쌓지 마세요(AGENTS.md 105KB, EXECUTION_INTEGRITY_NOTICE 확장). 강제해야 하는 것은 오케스트레이터 코드에서 검증합니다(예: push 후 원격 SHA 확인).
- notes-only PR 경로와 API provider를 pr 단계에 쓰는 일을 멈추세요.

## 전략 권고
- 사용자 정의: Claude Max와 ChatGPT Pro 같은 코딩 에이전트 구독을 2개 이상 이미 쓰면서 개인·소규모 OSS 저장소를 여러 개 관리하는 1인 메인테이너입니다. MAO가 가장 잘해야 할 한 가지 일은 '잘 정의된 이슈 하나를, 다른 벤더의 에이전트가 diff와 테스트로 검증한 머지 가능한 PR로 바꾸고, 사람은 마지막 승인만 하게 하는 것'입니다.
- 포지셔닝: 'MAO는 코딩 에이전트를 위한 교차 벤더 maker-checker입니다. Claude가 쓰고 Codex가 diff를 읽고 테스트를 돌려 판정하며, 구조화된 승인 없이는 아무것도 머지되지 않습니다. 내 구독, 내 머신, 내 GitHub에서 동작합니다.' 차별점은 단일 벤더 에이전트(Copilot agent, Codex cloud, Claude Code Action)가 구조적으로 제공할 수 없는 '다른 회사 모델의 독립 검증'입니다. GUI 칸반은 차별점이 아닙니다.
- 현재 품질에 대한 정직한 평가: WorkflowEngine 경로에서 신뢰할 수 있는 것은 'CLI Worker가 제목과 이슈 URL만 보고 만든 변경'까지입니다. 리뷰는 정보가 없고 머지 게이트는 CI뿐입니다. 이슈 본문은 프롬프트에 들어가지 않고 Worker가 URL을 따라가 읽을 때만 반영됩니다. Swarm 경로는 diff 기반 리뷰와 revision 루프가 있어 한 단계 위지만, MAO 자기 저장소 전용이고 머지 판단이 LLM에 맡겨져 있습니다. 둘 다 지금은 '감독 없이 머지'를 맡길 수준이 아닙니다.
- 하네스 개선 우선순위: (1) 컨텍스트 팩(이슈 본문, 규약, 검증 명령) → (2) PR head 체크아웃 기반 diff 리뷰와 JSON verdict, GitHub APPROVE/REQUEST_CHANGES 매핑 → (3) 결정론적 MergeGate와 family 기준 maker-checker → (4) 상한이 있는 revision 루프(N=2) → (5) 테스트 실행 검증 단계 → (6) 구조화 CLI 어댑터(stream-json/--json)로 transcript 스트리밍 → (7) usage/cost 원장 → (8) plan/spec 단계 → (9) 역할×모델별 평가 하네스. 1~4가 now이고 5~9가 next입니다.
- 엔진 수렴 방향: Swarm의 라이프사이클 모델(역할 태그, 신뢰 코멘트, revision, cooldown, family 구분)을 뼈대로 쓰고 WorkflowEngine의 강점(단일 preflight 관문, 순수 함수 선택 규칙, GUI 상태 표시)을 그 위에 얹습니다. 상태 원천은 GitHub 코멘트 regex가 아니라 MAO가 저장하는 구조화된 verdict입니다. GitHub 코멘트는 감사 기록으로만 씁니다.
- 모든 기본값은 사람 개입 쪽으로 둡니다. auto-trigger의 autoAdvance 기본값을 false로 하거나 merge 직전에 항상 pause합니다. 평가 하네스로 신뢰가 쌓이면 저장소별로 자동 머지를 켜게 합니다.
- Kill/pivot 기준(2027-02 점검): (a) MAO main 머지 PR 중 MAO 파이프라인이 만든 비율이 30% 미만, (b) 내부 평가 픽스처 해결률이 단일 Claude Code 세션보다 유의하게 낮음, (c) 외부 사용자 신호(스타, 외부 이슈, 외부 PR)가 0. 둘 이상 해당하면 Electron GUI와 4단계 파이프라인을 접고, 가장 날카로운 조각인 '교차 벤더 리뷰 게이트'(gh 확장이나 GitHub Action. PR이 열리면 다른 벤더 CLI가 체크아웃·테스트·JSON verdict를 수행하고 required check로 보고)로 피벗합니다.

## 로드맵 입력
- (now) notes-only PR 경로를 삭제하고 '변경 없음'을 needs-human으로 처리, API provider는 기본적으로 review 전용으로 제한 — 마크다운 노트가 기본 브랜치에 자동 머지되는 경로를 막는 가장 싼 수정입니다(workflow-engine.ts:895-898, 917-943).
- (now) auto-trigger와 Swarm 이슈 디스패치에 authorAssociation 또는 'mao:go' 라벨 신뢰 게이트 추가, 지시 태그 값은 허용 목록으로 검증 — 외부인이 sandbox 우회 에이전트를 실행시키고 모델과 검증자를 고를 수 있습니다(auto-trigger.ts:120, swarm_orchestrator.py:2481-2491).
- (now) ContextPack(이슈 본문, 코멘트, 규약 파일, 검증 명령)과 PR head 체크아웃 기반 diff 리뷰, JSON verdict, APPROVE/REQUEST_CHANGES 매핑, 결정론적 MergeGate — 지금 리뷰와 머지는 검증 흉내에 그칩니다. 제품 가치 제안 전체가 여기에 달려 있습니다.
- (now) maker-checker를 family(벤더/모델 패밀리) 기준, 태스크 history 전체 비교로 재정의하고 review/merge 단일 provider 완화를 제거 — 현재 기본 순환에서는 PR 작성자가 merge 단계를 맡고, 같은 모델 엔트리 두 개로 규칙이 무력화됩니다.
- (now) PR #107에서 provider-options와 buildModelEffortArgs만 분리해 머지하고, #1을 닫고, v0.2.0을 하네스 마일스톤으로 재정의 — 낡은 카탈로그와 codex --effort 오류를 바로 고치고 릴리스 차단을 풉니다.
- (now) WorkflowEngine에 provider cooldown과 실패 분류(quota/auth/timeout/empty) 도입, 빈 출력이거나 한도 메시지면 GitHub 쓰기 차단 — 구독 CLI 한도가 걸리면 태스크가 error로 쌓이거나 한도 메시지가 GitHub에 게시될 수 있습니다.
- (next) PR #107 머지 후 WorkflowEngine과 Swarm을 core/pipeline 하나로 수렴(상한 있는 revision 루프, plan 단계 포함) — 같은 기능을 두 엔진에 이중으로 구현하는 비용을 끝내고 GUI, CLI, Swarm이 같은 품질을 갖게 합니다.
- (next) 테스트 실행 검증 단계(Worker 자가 검증과 오케스트레이터 재실행), CI 'none' 저장소는 자동 머지 금지 — 개인 저장소 대부분에 CI가 없어 지금은 검증 없이 머지됩니다.
- (next) stream-json과 codex --json 구조화 어댑터, transcript 스트리밍, usage/cost 원장 — 15분 동안 아무것도 보이지 않는 실행을 디버깅 가능하게 하고, 모델 라우팅을 비용 데이터로 판단하게 합니다.
- (next) 평가 하네스(숨겨진 테스트가 있는 시드 이슈 픽스처, 심어둔 버그 리뷰 탐지율) nightly 실행 — 프롬프트와 모델 변경의 효과를 숫자로 확인할 수 있어야 하네스 개선이 감이 아니라 공학이 됩니다.
- (later) GitHub App 또는 Action 형태의 교차 벤더 리뷰 게이트를 독립 제품으로 분리 — Electron 설치 없이 가장 차별화된 가치를 배포할 수 있습니다. pivot 기준에 걸릴 때의 대안이기도 합니다.
- (later) 비용과 성공률 기반 역할별 자동 라우팅, 큰 이슈의 plan→다중 PR 분할 — 평가 데이터가 쌓인 뒤에야 의미가 있습니다.

## 유지보수자 질문
- 실제로 쓰는 엔진은 무엇입니까? WorkflowEngine(GUI/CLI)과 Swarm 중 하나만 남긴다면 어느 쪽이고, 8월 이후 MAO 개발에 MAO 파이프라인을 쓰지 않은 이유는 무엇입니까?
- 목표 사용자가 본인 한 명입니까, 외부 OSS 메인테이너입니까? 'private': true와 v0.1.0 이후 릴리스가 없는 상태로 보아 공개 배포 계획이 불분명합니다.
- 대상 저장소에 Swarm식 규약(.agents/rules, 태그가 달린 이슈 템플릿)을 요구해도 됩니까, 아니면 아무 저장소에서나 무설정으로 동작해야 합니까?
- 자동 머지를 기본 목표로 둡니까, 아니면 '머지 준비가 된 승인 PR'까지만 하고 사람이 머지하는 것을 기본으로 받아들일 수 있습니까?
- 태스크 하나당 허용할 비용과 시간 예산(구독 quota 기준)은 어느 정도이고, revision 루프 상한을 몇 번으로 둘 생각입니까?
- API(BYOK) provider를 pr 단계에서 계속 지원해야 하는 실제 사용 사례가 있습니까?
- PR #107은 언제 draft를 벗어날 예정이며, 카탈로그와 effort 수정만 먼저 분리해 머지하는 데 동의합니까?
