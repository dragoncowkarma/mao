# 리서치 원자료: 이용자와 시장

> 2026-11-12 조사. 하위 에이전트가 웹에서 수집한 결과를 편집 없이 실었습니다.
> 항목의 [verified] / [partially-verified] / [recalled]는 조사 당일 1차 출처를 직접 열어 확인했는지를 뜻합니다.
> 수치와 제품 상태는 빠르게 바뀝니다. 인용하기 전에 출처를 다시 확인하십시오. 요약은 [benchmarking.md](../benchmarking.md)와 [user-needs.md](../user-needs.md)에 있습니다.

## 요약
2026년 11월 현재 에이전트 코딩 시장은 (1) 채택은 폭발적(JetBrains 2026: 전문 개발자 90%가 주 1회 이상 에이전트 사용, 68% 매일; Stack Overflow 2026 4월 펄스: 업무 사용 59%, 매일 사용 14%→37%)이지만 (2) 다중 에이전트 조율은 소수(단일 69%, 전문화 다중 17%, 중첩/조율 다중 16%; 68%는 예측 가능한 단일 에이전트 선호)이고 (3) 병목은 '생성'에서 '검토·신뢰'로 이동했다(METR 2026-03: SWE-bench 통과 PR의 약 절반은 메인테이너가 머지하지 않음, 평균 격차 24.2pp). 플랫폼 사업자가 빠르게 흡수 중이다: GitHub Agent HQ(이슈를 Copilot/Claude/Codex에 배정, PR 코멘트에서 @Claude/@Codex 호출), Anthropic Agent Teams와 Claude Code Review(제3자 보도), OpenAI의 Claude Code용 공식 Codex 플러그인(교차 공급자 리뷰)과 Symphony(이슈 트래커 기반 자율 실행, Apache-2.0, 28k stars). 독립 오케스트레이터는 양극화: Conductor 시리즈 A $22M(2026-03-30), Vibe Kanban은 스타 28.6k에도 회사가 2026-04-10 폐업(대부분 무료 사용자, 지속 가능한 수익모델 부재), CodeRabbit은 시리즈 C $143M/$1.5B(2026-08). MAO와 가장 가까운 페르소나는 '여러 AI 구독/키를 가진 솔로 개발자'이며, 그 곳의 강한 수요(리뷰 병목, 감독 피로, 교차 공급자 검증)에 MAO의 maker-checker가 맞닿아 있으나 현재 구현은 diff 미전달·차단 불가 리뷰·리비전 루프 부재로 '신뢰할 수 있는 자동 머지'라는 핵심 약속을 증명하지 못한다. 권고: 'GUI 칸반'이 아니라 '증거 기반으로 안전하게 머지하는 교차 공급자 파이프라인(trusted merge)'으로 포지셔닝하고, API 키/공식 CLI 경로 중심으로 ToS 위험을 낮추며, 이름은 충돌이 많은 'MAO'를 설명적 이름으로 교체하는 것을 검토하고, 한국어 커뮤니티(GeekNews, velog, 디스콰이엇 등)를 첫 해자로 삼는다.

## 조사 대상

### GitHub Agent HQ (Copilot + Claude + Codex) — 플랫폼 벤더 멀티 에이전트 [verified]
- URL: https://github.blog/news-insights/company-news/welcome-home-agents/
- 무엇: GitHub이 2025-10-28 Universe에서 발표한 멀티 에이전트 허브. mission control로 여러 에이전트 작업을 배정/감시하고, 이후 Claude와 Codex가 Copilot Pro+/Enterprise에 추가됨(2026-02, 제3자 보도). 이슈를 여러 에이전트에 배정해 비교하고 PR 코멘트에서 @Claude/@Codex로 후속 작업을 요청한다.
- 견인력: Copilot 구독 기반 배포. 에이전트 세션 1회가 premium request 1회 소비(보도). 블로그가 Anthropic, OpenAI, Google, Cognition, xAI 에이전트를 '수개월 내' 제공한다고 밝힘.
- 특징: mission control(웹/VS Code/모바일/CLI 통합); 브랜치 단위 CI 실행 제어; 에이전트 PR에 대한 1차 코드 리뷰 단계 + GitHub Code Quality(공개 프리뷰); AGENTS.md 기반 지속 규칙, 조직 거버넌스 컨트롤 플레인 및 감사 로그; 샌드박스 Actions 환경에서 실행(제3자 보도)
- MAO 시사점: MAO의 'issue->PR->review->merge + 여러 공급자'는 12-18개월 내 GitHub 안에서 기본 기능이 될 가능성이 높다. 단순 오케스트레이션은 차별점이 되지 못한다.; GitHub이 못 하는 영역: 사용자가 소유한 키/로컬 CLI, 자체 정책, 오프라인/로컬 우선, GitHub 이외 호스트, 한국어 UX.; 거버넌스·감사 로그가 엔터프라이즈 판매 포인트이므로 MAO도 이력(history)·증거 기록을 일급 기능으로 만들어야 한다.

### Conductor (Melty Labs) — 독립 병렬 에이전트 데스크톱 앱(폐쇄형) [verified]
- URL: https://www.conductor.build/blog/series-a
- 무엇: 격리된 코드베이스 사본마다 코딩 에이전트를 돌리고 사람이 리뷰·머지하는 macOS 앱. 회사 블로그에 따르면 2026-03-30 시리즈 A $22M(Spark, Matrix 주도; YC 및 Notion/Linear 창업자 참여).
- 견인력: 회사 주장: 1월 이후 사용자 10배 증가, 여러 대형 기업 엔지니어가 사용(검증 불가). 집계 사이트들은 라운드 시점·밸류에이션이 서로 다름.
- 특징: 워크트리 격리 + 변경분 리뷰·머지 UI; 사용자 구독(Claude Code/Codex)으로 구동하는 구조로 알려짐; 향후 '대규모 AI 조직 관리 플랫폼'(폰~VPC)로 확장 계획(미출시)
- MAO 시사점: 투자 받은 경쟁자도 '사람이 리뷰·머지'에 머문다. 자동 머지 + 신뢰 증거는 아직 비어 있는 자리.; 가격/BYOK 정책은 페이지에서 확인되지 않음(미확인).

### Vibe Kanban (BloopAI) — 칸반형 오케스트레이터(OSS) [partially-verified]
- URL: https://vibekanban.com/blog/shutdown
- 무엇: 칸반 보드에서 Claude Code/Codex 등 에이전트에게 작업을 배정하는 오픈소스 도구. 운영사 Bloop이 2026-04-10 폐업하고 커뮤니티 유지 오픈소스로 전환(검색 결과 발췌 기준).
- 견인력: gh api 기준 28,661 stars, Apache-2.0, 오늘(2026-11-12) 푸시 있음. 폐업 사유: 수천 명 사용자 대부분이 무료여서 지속 가능한 사업모델을 못 찾음.
- 특징: 칸반 UI + 여러 에이전트 선택; 호스팅 원격 기능(이슈/코멘트/조직)은 30일 후 종료, 완전 로컬 구조로 전환
- MAO 시사점: 스타 수와 사용은 수익으로 이어지지 않는다. '칸반 UI로 에이전트 부리기'는 무료 대체재가 많아 유료 근거가 약함 - MAO가 같은 포지션이면 같은 길.; GUI 칸반은 MAO의 차별점이 아니다. 신뢰/검증 파이프라인이 차별점이어야 한다.; 로컬 우선 아키텍처는 사업이 끝나도 프로젝트가 살아남는 장점이 있다(오픈소스 지속성).

### Superset — 독립 병렬 에이전트 오케스트레이터(OSS) [partially-verified]
- URL: https://github.com/superset-sh/superset
- 무엇: 'Orchestrate an army coding agents in parallel with your own subscriptions'를 내세우는 Conductor/Codex 앱 대안. 라이선스 표기는 출처마다 다르나 gh api는 MIT로 보고.
- 견인력: gh api 기준 16,241 stars(2025-10 생성), 오늘 푸시. YC 2026 봄 배치 및 2026-05 Launch HN은 비교 사이트 보도(미확인).
- 특징: 5-7개 에이전트 안정 운영, 올해 말 100개 목표를 블로그에서 주장; 리뷰 병목을 핵심 문제로 서술; '자기 구독으로 구동'을 마케팅 포인트로 사용
- MAO 시사점: '자기 구독으로'를 전면에 내세우는 제품이 급성장 중이므로 ToS 리스크 설명과 API 키 경로가 신뢰 포인트가 될 수 있다.; 경쟁사 블로그가 리뷰 병목을 정확히 짚는다: 메시지는 겹치므로 MAO는 '병목을 푸는 구체 메커니즘'으로 차별화해야 한다.

### OpenAI Symphony — 플랫폼 벤더의 이슈 트래커 기반 자율 실행 [verified]
- URL: https://github.com/openai/symphony
- 무엇: Linear 보드를 감시하며 작업별 격리 실행으로 에이전트를 띄우고, CI 상태·PR 리뷰 피드백·복잡도 분석·영상 워크스루를 '작업 증거'로 제출한 뒤 승인되면 PR을 랜딩하는 스펙/참조 구현(Elixir, 실험적).
- 견인력: gh api 기준 28,022 stars, Apache-2.0, 2026-02-26 생성, 마지막 푸시 2026-09-15. 'trusted environments 테스트용 low-key preview'라고 명시.
- 특징: 이슈 트래커가 제어면, 에이전트는 작업자; proof of work(증거 패키지) 개념; SPEC.md로 자체 구현 유도
- MAO 시사점: MAO와 거의 같은 철학(관리하되 감독하지 않는다)을 OpenAI가 오픈소스로 제시했다 - 파이프라인 아이디어 자체는 방어 불가.; 'proof of work'(증거)가 핵심 어휘로 부상: MAO의 머지 단계도 CI+diff+리뷰 판정을 증거로 남겨야 한다.; Linear 중심이라 GitHub Issues 우선의 소규모 팀/OSS는 비어 있음.

### Optio (Show HN) — K8s 기반 티켓-to-PR 오케스트레이터 [verified]
- URL: https://hn.svelte.dev/item/47520220
- 무엇: 쿠버네티스에서 코딩 에이전트를 돌려 티켓에서 PR까지 진행하고 CI 실패와 리뷰어 요청을 에이전트에 되먹여 머지될 때까지 반복하는 오픈소스.
- 견인력: Show HN 약 86 points(미러 사이트 집계). 댓글은 직접 읽음.
- 특징: CI 실패/리뷰 코멘트 -> 다음 프롬프트(리비전 루프); K8s 요구사항은 '비현실적(non-starter)'이라는 댓글 반응
- MAO 시사점: HN 댓글의 핵심 우려: 사람 없는 리뷰('if you didn't review it you will sooner or later when it breaks'), 재시도 토큰 낭비, 격리/비밀 유출, 공유 파일 충돌, '사소한 이슈에만 통하는 것 아닌가'.; 인프라 요구가 낮을수록 환영받는다: MAO의 로컬 CLI/Electron 접근은 장점.

### ComposioHQ agent-orchestrator — 작업-to-머지 PR 에이전트 플릿(OSS) [partially-verified]
- URL: https://github.com/ComposioHQ/agent-orchestrator
- 무엇: 'task에서 merged PR까지 에이전트 플릿 계획·실행·감독', 데스크톱+모바일 앱, Claude Code/Codex 등 35개 이상 에이전트 지원.
- 견인력: gh api 기준 14,472 stars, Apache-2.0, 2026-02-13 생성(약 9개월), 오늘 푸시.
- 특징: 35+ 에이전트 지원; 모바일에서 감독
- MAO 시사점: 같은 'task to merged PR' 슬로건의 OSS가 9개월에 14k stars - 문구가 아니라 증거·신뢰로 차별화해야 한다.; 모바일/알림 같은 원격 감독 UX는 사용자들이 기대하는 영역(MAO에는 알림 없음).

### Claude Squad — 터미널 기반 병렬 에이전트 관리(OSS) [partially-verified]
- URL: https://github.com/smtg-ai/claude-squad
- 무엇: tmux + 워크트리로 여러 에이전트 세션을 관리하는 터미널 앱.
- 견인력: gh api 기준 8,789 stars, AGPL-3.0, 마지막 푸시 2026-08-20(성장 정체 징후).
- 특징: 세션 격리; 터미널 우선
- MAO 시사점: 초기 인기 OSS도 3개월 이상 푸시 공백이 생기면 탈락한다. 유지보수 속도와 릴리스 케이던스가 신뢰 신호.; AGPL은 기업 도입 장벽이 될 수 있으므로 Apache-2.0은 MAO의 이점.

### AWS Agent Squad (구 Multi-Agent Orchestrator) — 이름 충돌 / 범용 멀티 에이전트 프레임워크 [partially-verified]
- URL: https://github.com/awslabs/agent-squad
- 무엇: AWS Labs의 'Multi-Agent Orchestrator'가 Agent Squad로 개명됨. 대화 에이전트 라우팅용 프레임워크이며 코딩 워크플로 도구가 아님. 2fastlabs/agent-squad로 이전했다는 2차 출처 보도가 있으며 gh api는 두 경로 모두 동일 7,802 stars를 반환.
- 견인력: 7,802 stars, Apache-2.0, 2026-11-11 푸시.
- 특징: 개명 사례: 일반명사형 'Multi-Agent Orchestrator'가 검색에서 묻혀 개명한 것으로 보이나 이유는 미확인
- MAO 시사점: 'multi-agent orchestrator'는 일반 용어라 검색 충돌이 크다 - 'MAO' 약어도 마찬가지로 희석된다.; 대기업 프로젝트조차 이름을 바꿨다: 조기 개명은 비용이 낮다.

### MAO 이름 충돌 프로젝트군 — 이름 충돌 조사 [partially-verified]
- URL: https://pypi.org/project/mao-agents/
- 무엇: 검색에서 확인된 동명 프로젝트: PyPI mao-agents(LangGraph 기반 Multi Agent Orchestration), GitHub moakbal06/mao(이슈마다 워크트리 에이전트를 띄우는 Agent Orchestrator - MAO와 기능까지 유사), aiconnai/mao-marketplace(Claude Code 플러그인), npm maosorch(MAOS), maof, 제품헌트 'MAO - Multi-Agentic Orchestration Tool'.
- 견인력: 스타 수/다운로드는 미확인.
- 특징: 기능이 겹치는 동명 프로젝트(moakbal06/mao)까지 존재
- MAO 시사점: 'mao' 패키지명/CLI명 선점 불가 가능성, 검색 결과 희석.; 마오쩌둥을 떠올리는 연상은 기억 기반이므로(recalled) 검증 못 했으나, 중국어권/글로벌 마케팅에서 오해·민감성 요인이 될 수 있다.

### CodeRabbit — AI 코드 리뷰 상용 [partially-verified]
- URL: https://siliconangle.com/2026/08/12/coderabbit-bags-143m-help-companies-get-grip-explosion-ai-generated-code/
- 무엇: PR 자동 리뷰 SaaS. 2026-02 시리즈 B $60M(밸류 $550M), 2026-08 시리즈 C $143M(밸류 $1.5B, Atomico/Smash Capital 공동 주도), 'Agentic Change Management' 발표, 오픈소스용 무료 지원에 $10M 이상 약정(vcaonline 보도).
- 견인력: 매출 추정은 출처마다 상이($15M+ vs $40M, 모두 2차 추정).
- 특징: 사람/AI가 만든 변경을 검토·우선순위화·설명·모니터링; 리뷰 계층 자체가 시장이 됨
- MAO 시사점: 투자는 '생성'이 아니라 '검증·거버넌스' 계층으로 향한다. MAO의 리뷰 단계가 diff를 보지 못하는 현재 상태는 이 흐름과 정반대.; OSS 무료 제공이 표준화되어 OSS 메인테이너는 이미 무료 리뷰어를 쓸 수 있다 - 리뷰 어시스턴트 자체로는 못 이긴다.

### Claude Code Agent Teams / Code Review (Anthropic) — 플랫폼 벤더 멀티 에이전트 [partially-verified]
- URL: https://addyosmani.com/blog/claude-code-agent-teams/
- 무엇: 2026-02 Opus 4.6과 함께 실험 기능으로 공개된 Agent Teams(팀 리드, 공유 작업 목록, 메시징, 워크트리 격리)와 2026-03 Code Review(리서치 프리뷰)에 대한 제3자 보도. Anthropic 공식 문서는 직접 확인하지 못함.
- 견인력: 토큰이 단일 세션의 약 7배라는 보도 인용(미확인). 내부 리뷰 커버리지 16%->54%는 제3자 주장.
- 특징: 공급자 내부 멀티 에이전트(동일 공급자); 교차 공급자 검증은 제공하지 않음
- MAO 시사점: 동일 공급자 팀은 maker-checker의 '다른 공급자' 가치를 대체하지 못한다 - 이 점이 MAO의 구조적 틈새.; 단, OpenAI가 Claude Code용 공식 Codex 플러그인을 제공해(MindStudio 2026-04-01 보도) 교차 공급자 리뷰도 이미 한 줄 설치로 가능해짐.

### OpenHands — 범용 OSS 에이전트 플랫폼 [recalled]
- URL: https://github.com/All-Hands-AI/OpenHands
- 무엇: 오픈소스 AI 소프트웨어 개발 에이전트 플랫폼(설명은 기억 기반).
- 견인력: gh api 기준 93,290 stars, MIT, 오늘 푸시.
- 특징: 대규모 커뮤니티; 샌드박스 런타임(기억 기반)
- MAO 시사점: OSS에서 가장 크게 성장한 사례는 '모델 중립 + 샌드박스 + 커뮤니티'. 보안 격리를 갖추지 못한 MAO는 신뢰 면에서 불리.; 상세 기능은 이번 조사에서 직접 확인하지 않았다.

## 트렌드

- **병목이 코드 생성에서 리뷰·검증으로 이동** — 근거: Simon Willison(2025-10) '병목은 결과를 리뷰하는 속도', Superset·Mergify·contextstudios 블로그, 한국 블로그 braindetox(2026-08-09) '실질적 병렬 폭은 하루에 제대로 읽을 수 있는 변경량이 정한다'. CodeRabbit 시리즈 C $143M(2026-08). METR(2026-03): 통과 PR의 약 절반은 머지되지 않음, 24.2pp 격차. → 시사점: MAO 가치제안은 '더 많은 에이전트'가 아니라 '사람이 읽는 양을 줄이는 검증'이어야 한다. 현재 리뷰어가 diff를 못 보는 점이 가장 치명적인 신뢰 결함.
- **채택은 높지만 조율형 멀티 에이전트와 완전 자율은 소수** — 근거: Stack Overflow 2026-04 펄스(n=1,100): 단일 69%, 전문화 다중 17%, 조율 다중 16%; 63%는 에이전트를 완전 자동으로 두는 일이 드물거나 없음; 68%는 단일 에이전트 선호. JetBrains 2026: 90% 주 1회 이상 사용, 68% 매일. → 시사점: 총 주소 시장은 '여러 에이전트를 이미 쓰는 헤비 유저'로 좁다. 자동 머지는 기본값이 아니라 점진적 신뢰 단계(승인 모드 -> 조건부 자동)로 제공해야 한다.
- **플랫폼 벤더가 멀티 에이전트/이슈-to-PR을 기본 기능으로 흡수** — 근거: GitHub Agent HQ(블로그 2025-10-28; Claude/Codex 추가 2026-02 보도), OpenAI Symphony(2026-02 생성, 28k stars), Anthropic Agent Teams/Code Review(제3자 보도), OpenAI Codex 플러그인(2026-04 보도). → 시사점: 12-18개월 내 '이슈 배정 -> 에이전트 PR -> 리뷰'는 GitHub 안에서 무료/번들 기능이 될 가능성이 크다. MAO는 로컬 우선, 키 소유, 정책 커스터마이징, 비GitHub 환경, 한국어 UX 등 번들이 못 하는 영역에 서야 한다.
- **독립 오케스트레이터는 양극화: 투자 유치 vs 폐업** — 근거: Conductor 시리즈 A $22M(2026-03-30); Vibe Kanban 운영사 폐업(2026-04-10, 대부분 무료 사용자); Superset YC; ComposioHQ agent-orchestrator 9개월에 14k stars. → 시사점: 스타는 수익/지속성과 무관. 유료 의사는 팀·거버넌스·보안 기능에 있고 개인 UI에는 약하다. 1인 메인테이너 프로젝트는 무료 OSS로 유지 가능한 범위(로컬 CLI/GUI)에 집중하는 것이 현실적.
- **구독 하네스 제약 강화(Anthropic)와 API 키 경로로의 이동** — 근거: The Register(2026-02-20): 소비자 약관상 Free/Pro/Max OAuth 토큰을 다른 제품·도구·서비스에서 쓰는 것은 금지, OAuth는 Claude Code와 Claude.ai용; Agent SDK도 명시적으로 포함, `claude -p`는 기사에 언급 없음(미확정). 2026-04-04 OpenClaw 차단 등은 2차 보도. OpenAI는 프로그램 사용에 API 키 인증을 권장(공식 문서), 일부 제3자 도구에서의 ChatGPT 구독 사용은 별도 제휴(2차 보도). → 시사점: MAO가 `claude` CLI를 직접 spawn하는 것은 '공식 Claude Code 사용'에 가깝지만, 무인 자동 실행이 '일반적인 사용' 범위인지는 문서에 명시되지 않았다. API 키 프로바이더를 1급 경로로 두고, README에 구독 CLI 사용 위험을 명시하는 것이 안전.
- **교차 공급자 검증의 주류화** — 근거: MindStudio(2026-04-01): OpenAI 공식 Codex 플러그인으로 Claude 작성 -> Codex 리뷰, '자기 숙제 채점' 논리. Anthropic은 동일 공급자 내 멀티 에이전트 리뷰. → 시사점: maker-checker 개념은 유효성이 인정되지만 독점 아이디어가 아니다. 효과를 입증하는 데이터(교차 공급자 리뷰가 잡아낸 결함률)가 있어야 차별화된다.
- **병렬 에이전트의 실무 병목: 조용한 충돌, 한도, 리뷰 용량** — 근거: braindetox 2건(2026-07-20, 2026-08-09): 워크트리는 파일은 분리하지만 포트·DB·API 사용량·사람 주의력은 공유, 팬아웃은 토큰 N배, 구독 한도에 더 빨리 도달. Anthropic 지원 문서(검색 요약)도 병렬 사용 시 한도 소진이 빠르다고 안내. → 시사점: 작업 적합성 판단(독립 모듈/기계 검증 가능/저렴한 폐기), 동시성 상한, 비용·한도 가시화 기능이 필요. 현재 MAO는 단일 흐름 큐라 충돌은 적지만 처리량도 낮다.
- **증거 패키지(proof of work)와 거버넌스가 새 어휘** — 근거: Symphony의 proof of work, Agent HQ의 감사 로그·컨트롤 플레인, CodeRabbit의 Agentic Change Management. → 시사점: MAO 칸반/큐 UI의 각 단계 프롬프트·출력 기록은 이 방향의 씨앗이다. 이를 변경 단위 증거 카드(diff, 테스트, 리뷰 판정, 비용)로 발전시켜야 한다.

## 이용자 니즈

- [여러 AI 구독/키를 가진 솔로 개발자] 한 에이전트가 쓴 것을 다른 공급자가 검증해 주는 자동 리뷰(자기 숙제 채점 방지) — 근거: MindStudio(2026-04-01) 'use one model to write code and a different model from a different provider to review it' https://www.mindstudio.ai/blog/openai-codex-plugin-claude-code-cross-provider-review-3 — MAO 적합도: 높음 - maker-checker가 정확히 해당. 단 리뷰어가 diff를 못 보는 결함 해결이 선행 조건.
- [여러 AI 구독/키를 가진 솔로 개발자] 구독 한도·비용을 가로질러 작업을 라우팅(한 공급자 한도 소진 시 다른 공급자로) — 근거: braindetox(2026-08-09) '구독형 에이전트는 사용량 한도가 있어 동시 실행을 늘리면 한도에 더 빨리 도달' https://braindetox.kr/posts/orca_parallel_coding_agents_2026.html ; AWS 한국 블로그는 병행 사용의 숨은 비용을 '두 개의 인증·청구·거버넌스 경계'로 지적 https://aws.amazon.com/ko/blogs/tech/codex-claudecode-harness/ — MAO 적합도: 중간 - 공급자 선택/핀 기능은 있으나 한도 인지·자동 폴백·비용 추적이 없음.
- [솔로 개발자 / 소규모 팀] 리뷰 부담 감소: 사람이 읽기 전에 기계(테스트, 타입, 린트, 2차 모델)가 걸러내기 — 근거: braindetox: '해법은 사람 검토를 늘리는 것보다 테스트·정적 분석·모듈 계약 검사로 기계가 먼저 거르게 하는 것' ; Superset 블로그 '리뷰 병목이 에이전트 수에 선형 증가' https://superset.sh/blog/parallel-coding-agents-guide — MAO 적합도: 중간 - CI 게이트는 있으나 CI가 없으면 통과(none)로 간주하는 점이 약점.
- [솔로 개발자] 감독 없이 밤새/자리 비운 사이에 이슈를 처리하고 결과만 확인(babysitting 제거) — 근거: Show HN Broccoli/Optio 사례(리뷰 코멘트를 밤새 처리) https://hn.svelte.dev/item/47520220 ; Stack Overflow 펄스: 63%는 완전 자율 실행을 드물게/전혀 안 함 https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work — MAO 적합도: 중간 - auto-trigger와 큐는 있으나 알림·진행 스트리밍·리비전 루프 부재로 '자리 비움'을 못 뒷받침.
- [소규모 제품 팀] 자동 머지 전 명시적 정책(어떤 이슈/경로는 자동, 나머지는 사람 승인) — 근거: Optio 댓글 ramon156 'pin down where a human must be in order for this not to become a mess'; tim-projects 'if you didn't review it you will sooner or later when it breaks' https://hn.svelte.dev/item/47520220 — MAO 적합도: 낮음(현재) - 단계별 자동 진행 on/off만 있고 경로/라벨/위험도 기반 정책이 없음. 가장 큰 기회.
- [소규모 제품 팀] CI 실패와 리뷰 코멘트를 에이전트에 되먹여 수정하는 리비전 루프 — 근거: Optio README 요지(HN 소개): CI 실패·리뷰어 요청을 프롬프트로 되먹임; METR: 에이전트가 피드백에 반복 수정할 기회가 없었다는 점이 한계로 명시 https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/ — MAO 적합도: 낮음(메인 엔진), 중간(swarm 모드는 리비전 사이클 있음).
- [오픈소스 메인테이너] AI 슬롭 PR 방지와 외부 기여자 이슈를 신뢰 경계로 취급(작성자 게이팅) — 근거: METR(2026-03-10): 테스트 통과 패치의 약 절반이 코드 품질·저장소 규범 위반으로 머지 불가, 메인테이너 머지율 격차 24.2pp. 이 조사에서 메인테이너 커뮤니티 원문 인용은 확보하지 못함(미확인). — MAO 적합도: 낮음/위험 - 현재 auto-trigger가 모든 신규 오픈 이슈를 작성자 확인 없이 큐에 넣으므로 공개 저장소에서는 프롬프트 인젝션·남용 위험. 게이팅이 선행되어야 함.
- [오픈소스 메인테이너] 저장소 규범(AGENTS.md, CONTRIBUTING)을 지키는 에이전트 PR — 근거: METR: 거절 사유 1순위가 코드 품질/스타일/저장소 규범 미준수; GitHub Agent HQ는 AGENTS.md로 지속 규칙 제공 https://github.blog/news-insights/company-news/welcome-home-agents/ — MAO 적합도: 중간 - 프롬프트에 저장소 규범 컨텍스트(AGENTS.md, CONTRIBUTING, 최근 머지 PR 스타일)를 주입하면 즉시 개선 가능(현재는 제목만 전달).
- [플랫폼/DevEx 팀] 감사 가능성: 어떤 에이전트가 무엇을 했는지, 승인 흔적, 비밀 유출 방지 — 근거: Agent HQ의 컨트롤 플레인·감사 로그·허용 에이전트 정책 https://github.blog/news-insights/company-news/welcome-home-agents/ ; Stack Overflow 2025: 보안·프라이버시 우려 81%, 정확성 우려 87%(2차 보도 InfoWorld/DevOps.com) — MAO 적합도: 낮음 - 이력은 큐에 있으나 토큰 평문 저장, 샌드박스 없음, 단일 JSON 파일, 서명되지 않은 빌드가 엔터프라이즈 장벽.
- [플랫폼/DevEx 팀] 샌드박스·네트워크 격리·비밀 최소 권한 — 근거: Optio 댓글 MrDarcy 'Is there any sandbox isolation from the k8s platform layer?', nevon: egress 정책과 secrets 프록시 제안 https://hn.svelte.dev/item/47520220 ; Symphony는 'trusted environments' 전용 명시 https://github.com/openai/symphony — MAO 적합도: 낮음 - pr 단계에서 권한 프롬프트를 우회하는 CLI 에이전트를 실제 클론에 실행하므로 이 요구와 정반대.
- [에이전시/컨설턴트] 고객 저장소별 격리된 자격증명·프로젝트와 청구 가능한 사용량 보고 — 근거: 직접 인용 가능한 에이전시 1차 출처는 확보하지 못함(미확인). 간접 근거: 비용이 에이전트 도입 장벽이라는 응답이 2025 53% -> 2026 38%로 감소해도 존속 https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work — MAO 적합도: 낮음 - 프로젝트 사이드바는 있으나 비용 추적과 저장소별 자격증명 분리가 없음. 추측성 수요이므로 후순위.
- [비엔지니어 빌더] 이슈 한 줄 -> 동작하는 PR/배포까지 설명 가능한 진행 표시 — 근거: 직접 인용 확보 못함(미확인). 간접: 정확성 우려가 아키텍트 80%, 풀스택 61%로 높아(SO 펄스) 전문성이 낮은 사용자는 검증이 더 어렵다. — MAO 적합도: 낮음 - 칸반 GUI는 가깝지만 검증 능력이 없는 사용자에게 자동 머지는 위험. 쫓지 말 것.
- [모든 페르소나] 병렬 작업 간 충돌 방지와 '조용한 충돌'(병합은 되나 실행 시 깨짐) 탐지 — 근거: braindetox(2026-07-20) 공유 작업 트리·브랜치 탈취·스테이징 오염·머지 지옥 https://braindetox.kr/posts/multiple_ai_agents_one_repo_2026.html ; Optio 댓글 saltpath: 같은 파일 편집 시 조율 vs 머지 시점 충돌 — MAO 적합도: 중간 - 단일 흐름 큐라 충돌은 구조적으로 적음(장점). swarm은 워크트리 격리. 병합 후 통합 테스트 게이트는 부재.
- [솔로 개발자 / 소규모 팀] 실시간 진행 스트리밍·알림(모바일 포함)·중단/개입 버튼 — 근거: ComposioHQ agent-orchestrator의 데스크톱+모바일 감독 앱 https://github.com/ComposioHQ/agent-orchestrator ; Optio 댓글 olegbk: 에이전트가 같은 곳을 맴도는 것을 못 알아채 토큰 낭비 — MAO 적합도: 낮음 - 스트리밍·비용·알림이 모두 없음. 개입 지점(pause/advance/retry)은 있음.
- [한국어권 개발자] 한국어로 된 설정·문서·오류 메시지와 국내 커뮤니티에서 통용되는 워크플로 사례 — 근거: GeekNews에서 PR 자동화 스킬(/git-pr), /issues -> /work -> /review 흐름, 병렬 리뷰 파이프라인 사례가 활발히 공유됨 https://news.hada.io/topic?id=22716 , https://news.hada.io/topic?id=27817 ; 한국어 구독 병행 사용 비교 글 다수(AWS 한국 블로그, yozm.wishket) — MAO 적합도: 중간 - 유지보수자가 한국어 화자라 현지 커뮤니티 접근이 용이. 현재 UI·문서 언어는 영어 중심으로 보임(미확인).
- [모든 페르소나] 가격 예측성: 구독 한도·토큰 비용·재시도 낭비를 사전에 알기 — 근거: Anthropic Agent Teams는 단일 세션 대비 약 7배 토큰(제3자 보도, 미확인); Optio 댓글 naultic '재시도에 토큰을 많이 쓴다'; 팬아웃은 토큰 N배(braindetox) — MAO 적합도: 낮음 - 비용 추적 없음. 단계당 사용량 표시만 추가해도 차별점이 됨.
- [솔로 개발자 / 소규모 팀] 설치 마찰 없음: 쿠버네티스·클라우드 계정 없이 로컬에서 시작 — 근거: Optio 댓글 verdverm: 'Kubernetes as a requirement is a non-starter' https://hn.svelte.dev/item/47520220 — MAO 적합도: 높음 - Electron-free 코어 + CLI + 로컬 JSON 구조가 장점. 단 npm 패키지/서명 빌드 부재로 설치 마찰이 높음.

## 권고

- (P0/now) **리뷰어에게 실제 diff와 저장소 컨텍스트를 전달하고 리뷰를 '차단 가능한 판정'으로 승격** — 시장 병목이 리뷰·신뢰로 이동했고(METR 24.2pp 격차, CodeRabbit $143M) 경쟁자들은 모두 증거 기반 검증을 강조한다. 제목만 보는 리뷰어와 머지를 막지 못하는 코멘트는 maker-checker의 약속을 무의미하게 만든다. 가장 먼저 고칠 신뢰 결함. [출처: METR 2026-03-10; OpenAI Symphony proof of work; CodeRabbit; Agent HQ 1차 리뷰 단계]
- (P0/now) **머지 정책 엔진: CI 없음(none) 기본 차단, 필수 판정, 경로/라벨/크기 기반 자동·수동 선택** — HN 댓글과 SO 조사 모두 '완전 자율은 신뢰 못 함'(63%)을 보여 준다. 정책이 있는 단계적 자동화가 신뢰의 전제이며, 현재 CI 없음=통과는 정반대. [출처: Optio HN 댓글(ramon156, tim-projects); Stack Overflow 2026 펄스; GitHub 브랜치 컨트롤]
- (P0/now) **auto-trigger 작성자 게이팅(저장소 협업자/허용 목록/라벨 승인) 기본값 도입** — 공개 저장소에서 아무 이슈나 에이전트 프롬프트가 되는 구조는 OSS 메인테이너·팀 페르소나의 즉시 탈락 사유다. 신뢰 장벽 중 가장 저비용. [출처: Optio/보안 우려 댓글; Agent HQ 거버넌스; swarm 모드가 이미 리비전 피드백에 작성자 제한을 둠]
- (P1/next) **리비전 루프: CI 실패·리뷰 거절을 worker에게 되먹여 N회 재시도 후 사람에게 에스컬레이션** — Optio 등은 이를 핵심으로 삼고, METR도 피드백 반복 부재를 한계로 명시한다. swarm에 있는 기능을 메인 엔진으로 옮겨 GUI/CLI 일관성도 확보. [출처: Optio; METR caveat; ComposioHQ agent-orchestrator]
- (P1/next) **증거 카드와 사용량/비용 가시화(단계별 토큰·시간·구독 한도 소진 경고)** — 비용·한도 예측 불가는 반복 불만이며 유료 오케스트레이터들도 약한 영역. 저장된 이력 위에 얹을 수 있어 구현 비용 대비 효과가 크다. [출처: braindetox 비용/한도 분석; Symphony proof of work; Agent HQ 메트릭 대시보드]
- (P1/now) **API 키 프로바이더를 1급 경로로 문서화하고, 구독 CLI 경로의 약관 위험을 README/설정 UI에 명시** — Anthropic은 소비자 약관상 구독 OAuth를 Claude Code/Claude.ai 외 제3자 도구에서 쓰는 것을 금지했고, headless `claude -p`의 무인 자동 사용 허용 여부는 확인하지 못했다. 유지보수자 1인 프로젝트가 약관 이슈로 흔들리면 복구 비용이 크다. [출처: The Register 2026-02-20; OpenAI Codex 인증 문서(API 키 권장)]
- (P1/next) **비밀·샌드박스 기초 보안: 토큰 OS 키체인 저장, 클론 URL에서 토큰 제거, pr 단계 컨테이너/권한 축소 옵션** — 플랫폼/DevEx 및 OSS 페르소나의 거부 사유. 포지션을 '신뢰'로 잡으면서 평문 토큰·권한 우회가 남아 있으면 메시지가 자기모순. [출처: Optio 보안 댓글; Symphony 'trusted environments' 경고; Stack Overflow 보안 우려]
- (P1/now) **이름 변경 검토 및 선점 확인(패키지·도메인·검색), CLI 별칭 유지** — 'mao' 명칭은 PyPI mao-agents, moakbal06/mao(기능 유사), maosorch 등과 충돌하고 일반어 'multi-agent orchestrator'는 AWS 프로젝트도 개명했다. 사용자 0명인 지금이 개명 비용이 가장 낮다. [출처: AWS Agent Squad 개명; 동명 프로젝트 검색 결과]
- (P2/next) **한국어 커뮤니티 비치헤드: 한국어 README/데모 영상, GeekNews Show GN·velog·디스콰이엇 공개, 실제 파이프라인 실행 기록 공개** — 유지보수자가 한국어 화자이고 GeekNews에서 이슈->PR 자동화 흐름이 활발히 논의된다. 소규모이면서 피드백이 빠른 초기 사용자 확보 경로. [출처: GeekNews topic 22716, 27817, 28303; 한국어 병렬 에이전트 블로그]
- (P2/next) **npm/Homebrew 배포와 서명 빌드, 릴리스 케이던스 확립** — Claude Squad처럼 푸시가 멈추면 성장도 멈춘다. 설치 마찰이 로컬 우선 장점을 상쇄한다. [출처: Claude Squad 푸시 공백(마지막 2026-08-20); Vibe Kanban의 로컬 지속성]
- (P3/later) **알림·스트리밍·모바일 감독은 후순위로 두고 증거 중심 기능 이후 검토** — 사용자 요구는 있으나 대형 경쟁자(Composio, Conductor, Agent HQ 모바일)가 이미 제공하며 1인 프로젝트가 따라잡기 어렵다. [출처: ComposioHQ agent-orchestrator; Agent HQ 모바일]

## 질문별 답

1. (1) 가장 가까운 페르소나는 '여러 AI 구독/API 키를 가진 솔로 개발자(또는 2-3인 팀)'다. 근거: 로컬 CLI + BYOK, 교차 공급자 maker-checker, 단일 JSON/로컬 구조가 이 사용자의 마찰(인프라 없음, 여러 공급자)과 맞고, 팀·엔터프라이즈 기능(거버넌스, 샌드박스)은 아직 없다. 해결 가능한 미충족 니즈 순위: (a) 리뷰어가 diff를 보는 실질적 교차 공급자 검증과 차단 가능한 판정, (b) 머지 정책(CI 없음 차단, 경로/라벨 기반 승인 필요), (c) CI 실패·리뷰 거절을 되먹이는 리비전 루프, (d) 단계별 비용/한도 가시화, (e) 작성자 게이팅이 있는 안전한 auto-trigger, (f) 기본 보안(토큰 저장, 클론 URL). 근거 출처: METR, SO 펄스, Optio HN 댓글, braindetox.
2. (2) 쫓지 말아야 할 것: (a) 에이전트 수 경쟁/100개 병렬(Superset, Conductor가 자금력으로 앞서며 실사용자 다수는 단일 에이전트 69%), (b) 범용 GUI 칸반(Vibe Kanban 28k stars에도 폐업), (c) 모바일/원격 감독 앱, (d) 비엔지니어 대상 원클릭 자동 배포(검증 능력이 없는 사용자에게 자동 머지는 위험), (e) 대기업 거버넌스 플랫폼(Agent HQ, CodeRabbit과 직접 경쟁), (f) 구독 OAuth 우회 기능, (g) 쿠버네티스/클라우드 호스팅 서비스화.
3. (3) 자동 머지 신뢰 조건: 솔로 개발자는 '되돌리기 쉬움'과 증거(diff, 테스트 결과, 다른 공급자의 판정)와 비용 상한; 소규모 팀은 필수 CI, 보호 경로 승인, 감사 가능한 이력, 실패 시 자동 중단; OSS 메인테이너는 작성자 게이팅, 저장소 규범 준수, 사람 승인 기본값(자동 머지는 라벨로 옵트인); 플랫폼 팀은 샌드박스, 최소 권한 토큰, 서명된 빌드, 감사 로그. 공통 전제는 단계적 자율성(제안 -> 승인 후 머지 -> 조건부 자동)이다. 근거: Optio 댓글, SO 펄스 63%, METR의 거절 사유.
4. (4) 포지셔닝 3안. A) '교차 공급자 검증 파이프라인': 대상 솔로/소규모, 차별점 maker-checker, 증거 필요: 교차 공급자 리뷰가 잡은 결함 비율 비교 실험, 플랫폼 노출 높음(OpenAI Codex 플러그인, Agent HQ가 동일 개념 제공). B) '신뢰 가능한 머지(trusted merge)': 대상 소규모 팀/OSS, 차별점 정책 엔진 + 증거 카드 + 작성자 게이팅 + 차단 가능한 리뷰, 증거 필요: 테스트 저장소에서 머지 후 회귀율/되돌림 비율 공개, 플랫폼 노출 중간(번들이 정책 커스터마이징·로컬 키는 못 줌), 로드맵: P0 항목 전부. C) '로컬 우선 BYOK 이슈 러너(한국어권 개인/스튜디오)': 대상 한국 개발자·에이전시, 차별점 한국어 UX와 간편 설치, 증거 필요: 사용자 수와 후기, 플랫폼 노출 낮으나 시장 작고 방어력 약함. 추천: B를 중심으로 하고 A를 그 안의 메커니즘으로 포함, C를 유통 채널로 사용. 근거: 병목이 리뷰·신뢰로 이동(METR, CodeRabbit 자금), 플랫폼은 단순 오케스트레이션을 흡수 중(Agent HQ, Symphony), 무료 칸반 UI는 지속 불가(Vibe Kanban).
5. (5) 이름: 'MAO'와 'multi-agent orchestrator'는 일반어/약어로 충돌이 많다(mao-agents, moakbal06/mao, maosorch, AWS 프로젝트 개명 사례). 마오쩌둥을 연상시켜 중국어권·국제 마케팅에서 민감하게 읽힐 수 있다는 점은 기억 기반이라 이번에 검증하지 못했다. 권고: 아직 사용자·스타가 거의 없는 지금 개명을 검토하고, 후보를 npm/PyPI/GitHub/도메인/검색 결과에서 실제로 가용한지 확인한 뒤 결정한다. 이름 원칙: 짧고 발음 쉬움, 검색에서 일반어 아님, 기능(머지/검증/게이트)을 은유하는 단어, CLI 명령은 2-4자. 기존 `mao`는 CLI 별칭으로 한동안 유지. 구체 후보 이름은 가용성 미검증이어서 제시하지 않는다.
6. (6) 런칭 채널: 한국어권 비치헤드로 GeekNews(Show GN), velog/Brunch 기술 블로그, 디스콰이엇, Claude/Codex 한국 사용자 오픈채팅·디스코드, 페이스북 개발자 그룹(내용은 시장 탐색용으로 직접 검증하지 못함; GeekNews 병렬 에이전트·PR 자동화 글이 다수 존재하는 점만 확인). 이후 영어권: Show HN(쿠버네티스 불필요·로컬 우선·CI 없는 머지 차단을 제목에 사용), r/ClaudeCode·r/ChatGPTCoding(직접 스레드는 이번에 확보 못함), dev.to. 시연 자료는 '실제 저장소에서 이슈 -> PR -> 교차 리뷰 -> 거절/수정 -> 머지' 전 과정 영상과 측정 결과가 가장 설득력 있다. OKKY는 이번 검색에서 직접 근거를 확보하지 못했다.

## 출처

- https://github.blog/news-insights/company-news/welcome-home-agents/ — GitHub Agent HQ 기능, 2025-10-28 발표, 에이전트 파트너 일정
- https://helpnetsecurity.com/2026/02/05/github-enables-coding-agents/ — 2026-02 Claude/Codex 추가 및 Pro+/Enterprise 제한(2차 보도)
- https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/ — 통과 PR 약 절반 머지 불가, 24.2pp 격차, 거절 사유, 한계
- https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work — 2026-04 펄스: 단일 69%, 다중 17%/16%, 63% 완전 자율 드묾, 사용률 59%, 일일 14%->37%
- https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/ — 2026 개발자 설문 결과 발표(검색 요약만 확인, 본문 미열람)
- https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/ — JetBrains 2026: 90% 주 1회 이상, 68% 매일(검색 요약, 본문 403으로 미열람)
- https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access — Anthropic 약관: 구독 OAuth는 Claude Code/Claude.ai용, 제3자 도구 금지, Agent SDK 포함
- https://developers.openai.com/codex/auth — Codex 인증 방식(ChatGPT 로그인 vs API 키, 프로그램 사용엔 API 키 권장; 검색 요약)
- https://www.conductor.build/blog/series-a — Conductor $22M 시리즈 A, 2026-03-30, 회사 주장 지표
- https://vibekanban.com/blog/shutdown — Vibe Kanban 운영사 폐업 2026-04-10(검색 요약)
- https://github.com/openai/symphony — Symphony 설명, Linear 감시, proof of work, trusted environments 경고
- https://hn.svelte.dev/item/47520220 — Optio Show HN 댓글: 리뷰, 비용, 보안, 충돌, K8s 거부감
- https://www.mindstudio.ai/blog/openai-codex-plugin-claude-code-cross-provider-review-3 — 공식 Codex 플러그인과 교차 공급자 리뷰 논리(2026-04-01, 2차 블로그)
- https://siliconangle.com/2026/08/12/coderabbit-bags-143m-help-companies-get-grip-explosion-ai-generated-code/ — CodeRabbit 시리즈 C $143M(검색 요약)
- https://addyosmani.com/blog/claude-code-agent-teams/ — Claude Code Agent Teams 설명(2차 출처, Anthropic 공식 문서 미확인)
- https://braindetox.kr/posts/multiple_ai_agents_one_repo_2026.html — 한 레포 다중 에이전트 문제와 완화 패턴(2026-07-20)
- https://braindetox.kr/posts/orca_parallel_coding_agents_2026.html — 병렬 에이전트 한계·비용·리뷰 병목(2026-08-09)
- https://news.hada.io/topic?id=22716 — GeekNews: /issues -> /work -> /review 흐름(검색 요약)
- https://news.hada.io/topic?id=27817 — GeekNews: /git-pr 스킬 PR 자동화(검색 요약)
- https://aws.amazon.com/ko/blogs/tech/codex-claudecode-harness/ — Codex+Claude Code 병행 사용의 숨은 비용(검색 요약)
- https://arxiv.org/html/2602.02345 — AIDev 기반 에이전트 PR 수용률 연구(Codex 0.83, Copilot 0.45; 검색 요약, 본문 미열람)
- https://pypi.org/project/mao-agents/ — 동명 프로젝트 mao-agents(검색 결과)
- https://github.com/moakbal06/mao — 동명 프로젝트(이슈별 워크트리 에이전트; 검색 결과)
- https://github.com/awslabs/agent-squad — AWS Multi-Agent Orchestrator 개명 후 저장소, gh api 7,802 stars
- https://github.com/BloopAI/vibe-kanban — gh api: 28,661 stars, Apache-2.0, 오늘 푸시
- https://github.com/superset-sh/superset — gh api: 16,241 stars, MIT
- https://github.com/ComposioHQ/agent-orchestrator — gh api: 14,472 stars, 2026-02-13 생성
- https://github.com/smtg-ai/claude-squad — gh api: 8,789 stars, AGPL-3.0, 마지막 푸시 2026-08-20
- https://github.com/All-Hands-AI/OpenHands — gh api: 93,290 stars, MIT

## 확인하지 못한 것
검색은 약 28회 도구 호출 예산 안에서 수행했고 WebSearch 결과 다수는 요약 형태이며 원문을 직접 열어 확인한 것은 METR, GitHub 블로그, The Register, Conductor, Symphony, Optio HN 댓글, Stack Overflow 펄스, braindetox 2건뿐이다. 나머지(Vibe Kanban 폐업, CodeRabbit 자금, JetBrains 2026 수치, Stack Overflow 2026 본조사, AIDev 수용률, Anthropic Agent Teams/Code Review, OpenAI 구독 정책)는 검색 요약 또는 2차 보도이며 'partially-verified'로 취급해야 한다. 확인하지 못한 것: (1) Reddit(r/ClaudeAI, r/ClaudeCode, r/ChatGPTCoding, r/cursor, r/ExperiencedDevs) 실제 스레드와 인용 - 검색에서 노출되지 않았다. (2) OKKY 글. (3) Hacker News 2026 대형 논의 스레드는 Optio 하나만 직접 읽었다. (4) Anthropic 공식 약관 원문과 `claude -p` 무인 실행 허용 여부 - 기사에 언급이 없어 확정하지 못했고 법률 자문이 아니다. (5) OpenAI 자동화/제3자 정책 원문. (6) GitHub Octoverse 2026, DORA 2026(2025 보고서 요약만 확인), 에이전트 PR 수용률의 일관된 수치(출처 간 불일치). (7) Google Jules/Antigravity, Cursor의 멀티 에이전트 로드맵은 조사하지 못했다. (8) Superset 라이선스와 YC 관련 주장, Conductor 기업 사용 주장, CodeRabbit 매출 추정은 서로 충돌하거나 회사 주장이다. (9) 'MAO'의 정치적 연상과 중국어권 민감성은 기억 기반 의견이며 검증하지 않았다. 대체 이름의 상표/패키지 가용성도 확인하지 않았다. (10) 스타 수는 2026-11-12 gh api 조회 시점의 값이며 프로젝트 성장 속도(특히 Superset 16k)의 원인 분석은 소스 부족으로 추정이다. (11) 페르소나 중 에이전시와 비엔지니어 빌더의 인용은 확보하지 못해 해당 userNeeds는 간접 근거에 의존한다. 개인 정보는 외부 검색어에 포함하지 않았다.
