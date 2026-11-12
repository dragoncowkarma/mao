# 리서치 원자료: 경쟁·인접 제품

> 2026-11-12 조사. 하위 에이전트가 웹에서 수집한 결과를 편집 없이 실었습니다.
> 항목의 [verified] / [partially-verified] / [recalled]는 조사 당일 1차 출처를 직접 열어 확인했는지를 뜻합니다.
> 수치와 제품 상태는 빠르게 바뀝니다. 인용하기 전에 출처를 다시 확인하십시오. 요약은 [benchmarking.md](../benchmarking.md)와 [user-needs.md](../user-needs.md)에 있습니다.

## 요약
2026-11-12 기준으로 MAO의 직접 이웃(병렬 에이전트 오케스트레이터 앱)과 플랫폼 벤더(GitHub, Anthropic, OpenAI, Google, Cursor, Cognition, AWS)를 확인했다. 핵심 결론은 네 가지다. (1) 로컬 오케스트레이터 시장은 이미 포화다. Emdash(Apache-2.0, YC W26, v1.2.11, 이슈 트래커 10종 연동), Paradev(구 Superset, 약 16k 별), cmux(약 28.8k 별), Conductor(0.94.0)가 worktree 격리, diff 리뷰, PR/CI/머지, 에이전트 상태 알림을 모두 제공한다. Vibe Kanban은 2026-04-10 회사가 종료됐고 커뮤니티 유지 상태다. (2) issue→PR→review→merge 자체는 플랫폼의 기본 기능이 됐다. GitHub Agent HQ는 Copilot, Claude, Codex에 이슈를 할당하고(공개 프리뷰, Pro+/Enterprise) 세션당 프리미엄 요청 1건을 소모한다. Copilot 클라우드 에이전트는 쓰기 권한자만 트리거할 수 있고, 요청자가 자기 PR을 승인할 수 없으며, 에이전트는 PR을 ready로 바꾸거나 머지할 수 없고, Actions는 사람이 승인해야 돈다. Claude Code는 Actions(@claude), 클라우드 세션, PR auto-fix, 다중 에이전트 Code Review를 제공한다. Codex는 @codex review와 자동 리뷰를, Cursor는 Bugbot Autofix와 클라우드 에이전트를, Devin은 리뷰 코멘트 autofix를, Kiro와 OpenHands는 라벨 트리거를 제공한다. (3) MAO가 제대로 못 하는 부분, 곧 테이블 스테이크스 부족분은 리뷰어가 diff를 본다는 점, 차단 가능한 리뷰, 리뷰 코멘트에 의한 수정 루프, 작성자(트리거) 게이팅, 샌드박스/네트워크 제한, 라이브 트랜스크립트와 알림이다. 이 항목들은 거의 모든 경쟁 제품이 이미 갖췄다. (4) 남는 차별점은 두 가지다. 벤더 중립이면서 로컬 우선인 크로스 벤더 maker-checker를 파이프라인 규칙으로 강제하는 것과, 여러 벤더의 에이전트(로컬 CLI와 클라우드)를 한 곳에서 감독하는 것이다. 조사한 범위에서 이를 정책으로 강제하는 제품은 찾지 못했다. 비슷한 시도는 Claude Code용 커뮤니티 skill(Claude+Codex 교차 리뷰) 수준이고, Agent HQ는 여러 에이전트에 같은 작업을 맡기고 역할을 나눠 리뷰하라고 권할 뿐 강제하지는 않는다(출처 문서 기준). 다만 부재를 증명한 것은 아니다.

## 조사 대상

### Emdash — 로컬/데스크톱 병렬 에이전트 오케스트레이터 [verified]
- URL: https://github.com/generalaction/emdash
- 무엇: 작업마다 Git worktree를 주고 여러 CLI 에이전트를 병렬 실행하는 데스크톱 앱(macOS/Windows/Linux). 로컬 프로젝트와 SSH/SFTP 원격 머신을 모두 지원한다.
- 견인력: gh api 기준 약 6.2k 별, Apache-2.0, 최신 v1.2.11(2026-11-06), 마지막 push 2026-11-10. YC W26. 저장소 생성은 2025-08.
- 특징: Linear, GitHub, Jira, GitLab, Asana, Monday.com, Forgejo, YouTrack 등 이슈/티켓을 에이전트에 바로 전달; diff 리뷰, PR 생성, CI 체크 확인, 머지를 한 화면에서 처리; Claude Code, Codex, Cursor, OpenCode, Amp, Devin, Qwen, Droid, Copilot 등 CLI 자동 감지; 에이전트 lifecycle hook으로 상태, 알림, 재개 가능한 세션 추적; SSH 원격 프로젝트, 자격증명은 OS keychain 저장
- MAO 시사점: MAO의 가장 가까운 UI 경쟁자이며 서명된 설치본, Windows/Linux, 브랜드 호환 이슈 소스 폭에서 앞선다. 이슈 소스 어댑터(Linear/Jira) 확장을 벤치마크할 가치가 있다.; hook 기반 상태/알림 추적은 MAO의 '라이브 출력 없음' 약점을 메우는 현실적 방법이다.; Emdash에는 maker-checker처럼 벤더를 교차 강제하는 규칙이 README에 없다(확인 범위 한정).

### Paradev (구 Superset) — 로컬/데스크톱 병렬 에이전트 오케스트레이터 [verified]
- URL: https://github.com/ParadevAI/Paradev
- 무엇: worktree/브랜치/터미널을 작업별로 주는 데스크톱 앱. 'Codex App과 Conductor의 오픈소스 대안'을 표방한다. 에이전트 자체는 아니며 모델 호출을 프록시하지 않는다.
- 견인력: gh api 기준 약 16.2k 별, MIT, 최신 desktop-v2.0.8(2026-11-10). 요청한 superset-sh/superset 경로는 ParadevAI/Paradev로 리다이렉트됐다. macOS(Apple Silicon/Intel) 정식, Linux는 실험적 AppImage, Windows 미지원.
- 특징: Changes 창에서 리뷰, 커밋, 푸시, PR 생성, PR 창에서 체크/리뷰 스레드/머지; 앱 내 브라우저로 워크스페이스별 dev server 미리보기; 사이드바에 working/done/waiting 에이전트 상태; 원격 호스트, iPhone/iPad 앱, 일정/이벤트로 에이전트를 시작하는 자동화(Pro 플랜)
- MAO 시사점: 리뷰 스레드와 머지까지 앱 안에서 끝내는 흐름, 모바일 앱, 이벤트 기반 자동화가 표준이 되고 있다.; 일부 기능(자동화)이 유료 Pro여서 오픈 코어+유료 상용 모델의 실례다.

### Vibe Kanban — 칸반 기반 에이전트 오케스트레이터 [verified]
- URL: https://github.com/BloopAI/vibe-kanban
- 무엇: 칸반 이슈로 계획하고 워크스페이스(브랜치+터미널+dev server)에서 10종 이상 코딩 에이전트를 실행하며 diff 인라인 코멘트를 에이전트에 보내는 도구.
- 견인력: gh api 기준 약 28.7k 별, Apache-2.0, 마지막 push 2026-11-11. 회사 bloop은 2026-04-10에 종료됐고 원격 서비스(칸반 이슈, 코멘트, 프로젝트, 조직)는 30일 후 제거, 프로젝트는 커뮤니티 유지 오픈소스로 계속된다. 마지막 정식 태그는 v0.1.44(2026-04-24).
- 특징: 칸반 이슈 계획 + 워크스페이스 실행; diff 인라인 코멘트를 에이전트에 직접 전달; 내장 브라우저(devtools, 디바이스 에뮬레이션); Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode 등 전환
- MAO 시사점: 가장 유명한 칸반 오케스트레이터가 '무료 사용자 다수, 사업 모델 못 찾음'을 이유로 접었다. 오케스트레이터 앱 자체는 수익화가 어렵다는 선례다.; MAO의 칸반 정체성은 차별점이 못 된다. 인라인 diff 코멘트 -> 에이전트 피드백이 이 시장의 핵심 상호작용이다.

### Conductor — 로컬/데스크톱 병렬 에이전트 오케스트레이터 (macOS 전용) [partially-verified]
- URL: https://www.conductor.build
- 무엇: Claude Code, Codex, Cursor 에이전트를 격리된 워크스페이스에서 병렬 실행하고 변경을 리뷰/머지하는 Mac 앱(Melty Labs).
- 견인력: 공식 페이지에서 최신 0.94.0 확인. 별 수는 소스 비공개라 확인 못 함. 가격은 출처마다 달라(무료 vs Pro $50/Teams $60) 미확인.
- 특징: Claude Code, Codex, Cursor 지원(제3자 글에는 OpenCode도 언급, 미확인); 격리 워크스페이스, 변경 리뷰와 머지; 제3자 글 기준 Dispatcher(작업을 에이전트에 라우팅) 기능이 v0.63.0(2026-06)에 추가됨(단일 출처)
- MAO 시사점: 상용 클로즈드 소스가 빠른 릴리스(0.63 -> 0.94)로 달리고 있다. MAO가 UI 완성도로는 따라가기 어렵다.; 'Dispatcher'류 자동 라우팅은 MAO의 provider 선택 규칙과 겹치므로 비교 대상이다.

### cmux — 에이전트용 터미널 [partially-verified]
- URL: https://github.com/manaflow-ai/cmux
- 무엇: Ghostty 기반 macOS 터미널로 세로 탭과 에이전트 알림을 제공한다. 오케스트레이터가 아니라 '에이전트 멀티태스킹용 터미널'이다.
- 견인력: gh api 기준 약 28.8k 별(저장소 생성 2026-01-28, 즉 약 9.5개월), 라이선스 NOASSERTION, 최신 v0.65.2.2(2026-10-27).
- 특징: 세로 탭, 에이전트 알림; 프로그래머블(스크립트 가능); 다국어 README
- MAO 시사점: 알림과 터미널 경험만으로도 28k 별이 나온다. 에이전트 대기/완료 알림이 얼마나 강한 수요인지 보여준다.; 오케스트레이션 없이 '터미널 UX'로 시장을 잡을 수 있다는 반례다.

### Claude Squad — 터미널(TUI) 병렬 에이전트 관리자 [partially-verified]
- URL: https://github.com/smtg-ai/claude-squad
- 무엇: tmux + worktree로 Claude Code, Codex, OpenCode, Amp 등 여러 터미널 에이전트를 관리하는 TUI.
- 견인력: gh api 기준 약 8.8k 별, AGPL-3.0, 마지막 push 2026-08-20(약 3개월 정체).
- 특징: TUI에서 여러 세션 관리; worktree 격리
- MAO 시사점: 활동이 둔화됐다. 단순 병렬 세션 관리자는 Emdash/Paradev/Codex 앱으로 흡수되는 중이다.

### Sculptor (Imbue) — 로컬/데스크톱 병렬 에이전트 오케스트레이터 [partially-verified]
- URL: https://github.com/imbue-ai/sculptor
- 무엇: 격리된 워크스페이스에서 코딩 에이전트를 병렬 실행하는 데스크톱 앱. 연구 프리뷰이며 외부 기여는 받지 않는다.
- 견인력: gh api 기준 약 246 별, MIT, 최신 sculptor-v0.49.0(2026-10-21), 마지막 push 2026-11-12. macOS(Apple Silicon)/Linux.
- 특징: spec, mocks, fix-bug 등 내장 skill 라이브러리(재현 인터뷰 -> 실패 테스트 -> 통과); 같은 워크스페이스에 에이전트를 추가해 협업
- MAO 시사점: 별은 적지만 '워크플로 skill 번들'로 차별화를 시도한다. 단계별 프롬프트 품질 접근의 참고가 된다.

### Nimbalyst (구 Crystal) — 로컬/데스크톱 병렬 에이전트 오케스트레이터 [verified]
- URL: https://github.com/stravu/crystal
- 무엇: Crystal은 2026-02 폐기되고 Nimbalyst(마크다운, 코드, 스프레드시트, 다이어그램을 함께 다루는 AI 네이티브 워크스페이스)로 대체됐다.
- 견인력: Crystal 저장소 약 3.1k 별, MIT, 마지막 릴리스 v0.3.5(2026-02-26)에서 정체.
- 특징: worktree 격리 병렬 세션; 에이전트가 열린 에디터에 편집을 실시간 스트리밍
- MAO 시사점: 단순 병렬 세션 관리 제품이 더 넓은 워크스페이스로 피벗했다. 생존 압력이 큰 구간이다.

### Happy / Omnara / Terragon (원격·모바일 계열) — 원격/모바일 에이전트 접근 [partially-verified]
- URL: https://github.com/slopus/happy
- 무엇: Happy는 Claude, Codex, Grok을 한 앱에서 조율하며 기존 구독을 재사용하는 MIT 오픈소스. Omnara는 자체 호스팅 가능한 'managed agent platform'. Terragon은 클라우드 백그라운드 에이전트 오케스트레이터였으나 저장소가 사이트만 남은 'formerly' 상태.
- 견인력: gh api 기준 Happy 약 24.6k 별(MIT), Omnara 약 3.4k 별(Apache-2.0), Terragon-oss 약 261 별. 모두 공개 상태로 Happy/Omnara는 2026-11-12 push.
- 특징: 모바일/원격에서 로컬 에이전트 감독과 응답; Terragon은 종료 후 코드만 남음
- MAO 시사점: '어디서든 에이전트에 응답/승인'은 큰 수요다(Happy 24k 별). MAO는 폴링 GUI뿐이다.; Terragon의 종료는 클라우드 오케스트레이터 사업의 위험을 보여준다(종료 사유는 확인 못 함).

### OpenAI Codex 앱/클라우드/GitHub 리뷰 — 플랫폼 벤더 (데스크톱 + 클라우드 + 리뷰) [partially-verified]
- URL: https://openai.com/index/introducing-the-codex-app/
- 무엇: macOS Codex 앱(2026-02 출시, worktree별 에이전트 스레드, Automations 스케줄 실행, 리뷰 큐), PR에 @codex review 또는 자동 리뷰.
- 견인력: openai/codex 약 135k 별, Apache-2.0. 제3자 글 기준 Windows 2026-03, ChatGPT 데스크톱으로 병합(2026-07), Linux 프리뷰(2026-08)는 공식 확인 못 함.
- 특징: @codex review: P0/P1만 지적하고 AGENTS.md의 'Code Review Rules'를 따름; 자동 리뷰는 설정에서 켜며 트리거 PR 이벤트 선택; 보안 리뷰(@codex security review, 연구 프리뷰)
- MAO 시사점: 리뷰어가 AGENTS.md 규칙을 읽는 방식은 MAO의 리뷰 프롬프트 설계에 바로 쓸 수 있다.; 공식 문서는 누가 @codex를 트리거할 수 있는지 밝히지 않았다.

### GitHub Copilot 클라우드 에이전트 + Agent HQ — 플랫폼 벤더 컨트롤 플레인 [verified]
- URL: https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/
- 무엇: 이슈를 Copilot, Claude, Codex(또는 셋 모두)에 할당하고 비동기 세션과 초안 PR을 받는 GitHub 네이티브 컨트롤 플레인. Agent HQ/Mission Control은 2025-10 발표.
- 견인력: Claude/Codex는 공개 프리뷰(블로그 2026-02-04), Copilot Pro+ 또는 Enterprise 필요, 세션당 프리미엄 요청 1건. Claude 에이전트 모델에 Sonnet 4.6, Opus 4.6 등(2026-04 changelog). GA 공지는 찾지 못했다.
- 특징: 쓰기 권한 사용자만 트리거. 쓰기 권한 없는 사용자의 코멘트는 에이전트에 전달되지 않음; 에이전트는 단일 브랜치(기존 PR 브랜치 또는 copilot/*)에만 푸시, 브랜치 보호와 필수 체크 적용; 요청자는 자기 PR을 승인 못 함. 에이전트는 PR을 ready 처리/승인/머지 불가; Actions 워크플로는 쓰기 권한자가 'Approve and run workflows'를 눌러야 실행; 방화벽 허용 목록, Agent Merge(Watch and fix로 CI 실패/충돌 수정), Automations, Agentic Workflows, 엔터프라이즈 에이전트 허용 정책
- MAO 시사점: MAO의 이슈 -> PR -> 리뷰 -> 머지를 같은 이슈 할당 UX로 이미 상용화했고, 가드레일(자기 PR 승인 불가, CI 승인, 단일 브랜치)이 MAO보다 강하다.; 같은 작업을 여러 에이전트에 배정해 비교하고 리뷰 역할을 나누자는 가이드가 있지만, 벤더 교차 리뷰를 강제하지는 않는 것으로 보인다(문서 기준).

### Claude Code (Actions, 클라우드 세션, Code Review, agent teams) — 플랫폼 벤더 [verified]
- URL: https://code.claude.com/docs/en/github-actions
- 무엇: @claude GitHub Action, claude.ai/code 클라우드 세션(PR auto-fix 포함), Team/Enterprise용 관리형 Code Review, 실험적 agent teams.
- 견인력: anthropics/claude-code-action 약 9.9k 별, MIT, 2026-11-12 push.
- 특징: Actions: 이슈/PR 코멘트에서 @claude. 쓰기 권한 필수, 봇 액터는 allowed_bots로 허용하지 않으면 거부; Code Review: 다중 에이전트 병렬 탐색 후 검증 단계로 오탐 제거, 심각도 순 인라인 코멘트. 리뷰는 PR을 승인하거나 차단하지 않고 체크 런도 실패로 끝나지 않으며 REVIEW.md는 베이스 브랜치에서만 읽음; 클라우드 세션: 격리 VM, 제한적 네트워크 기본값, GitHub 자격증명은 VM 밖 프록시, PR auto-fix가 CI 실패와 리뷰 코멘트에 반응; agent teams는 기본 꺼진 실험 기능이며 팀원끼리 메시지를 주고받고 공유 태스크 목록을 사용; 원격 제어: 모바일/브라우저에서 로컬 세션 조종
- MAO 시사점: Anthropic의 리뷰도 '차단하지 않는다'는 설계다. MAO의 비차단 리뷰가 업계에서 이상한 것은 아니다. 차이는 검증 단계와 심각도다.; 같은 벤더 안에서의 다중 에이전트(agent teams)가 이미 있다. 다른 벤더가 필요한 이유는 상관 오류 감소로 설명해야 한다.

### Cursor (클라우드 에이전트, Bugbot Autofix, Agents 창) — 플랫폼 벤더 [partially-verified]
- URL: https://cursor.com/blog/bugbot-autofix
- 무엇: 격리 VM 클라우드 에이전트, PR 리뷰 봇 Bugbot과 Autofix, 멀티 에이전트 창.
- 견인력: 공식 changelog 기준 Bugbot Autofix 2026-02 출시(Autofix 변경 중 35% 이상이 병합됨), 2026-06 Bugbot이 3배 빠르고 22% 저렴해졌다고 공지. 세부는 검색 요약 기반이라 일부 제3자 수치는 미확인.
- 특징: Bugbot이 PR 문제를 찾고 클라우드 에이전트가 VM에서 테스트 후 수정, @cursor 명령으로 병합하거나 브랜치에 직접 푸시; 클라우드 에이전트를 원하는 만큼 병렬 실행, 서브에이전트, 멀티 리포 환경
- MAO 시사점: 리뷰 -> 자동 수정 -> 병합 루프가 상용화됐다. 병합 비율 같은 '수용률' 지표를 공개해 측정한다는 점이 벤치마크 아이디어다.

### Google Jules / Antigravity 2.0 — 플랫폼 벤더 [partially-verified]
- URL: https://thenextweb.com/news/google-antigravity-2-desktop-cli-sdk-io-2026
- 무엇: Jules는 비동기 클라우드 코딩 에이전트(웹, CLI, API, GitHub 라벨). Antigravity 2.0은 2026-05 I/O에서 나온 데스크톱 Agent Manager, CLI, SDK 멀티 에이전트 플랫폼.
- 견인력: Jules 요금은 제3자 인덱스 기준 무료 하루 15개, Pro $19.99(100), Ultra $124.99(300)이며 공식 확인 못 함. Antigravity는 계층형 오케스트레이터 + 서브에이전트, 스케줄 태스크, 서브에이전트별 worktree(단일 출처).
- 특징: Jules Tools CLI로 원격 세션 관리; Antigravity에서 Claude/Codex 지원 여부는 확인하지 못함
- MAO 시사점: Google도 에이전트 매니저 + 자동 worktree로 수렴했다. 다만 자사 모델 중심이라 교차 벤더는 약해 보인다(미확인).

### Devin (Cognition) / Devin Desktop — 자율 이슈->PR 에이전트 [partially-verified]
- URL: https://cognition.ai/blog/closing-the-agent-loop-devin-autofixes-review-comments
- 무엇: 자율 소프트웨어 엔지니어 에이전트. Devin Review와 다른 리뷰 봇의 코멘트를 자동 수정(Autofix)하고, Windsurf 후속 Devin Desktop(2026-06)에 로컬/클라우드 에이전트 커맨드 센터가 있다.
- 견인력: Autofix 공지 2026-02, Windsurf 연동 2026-05-06. 가격은 출처가 충돌해(Core $20 + ACU $2.25 대 Pro $20 등) 확인 못 함.
- 특징: Autofix가 리뷰 봇 코멘트를 읽고 PR 브랜치에 수정 커밋; 리뷰 봇 트리거를 설정에서 지정
- MAO 시사점: '리뷰 -> 수정' 폐루프가 제품 슬로건이 됐다. MAO 메인 엔진에는 이 루프가 없다.

### Kiro / OpenHands / Factory — 자율 이슈->PR 에이전트 [partially-verified]
- URL: https://kiro.dev/docs/autonomous-agent/github/
- 무엇: Kiro(AWS): 이슈에 kiro 라벨 또는 /kiro 코멘트로 시작, 자율 모드가 질문, 계획, 서브에이전트 위임, PR 개설. OpenHands: 이슈에 openhands 라벨 또는 @openhands. Factory Droids: Linear/Jira/GitHub 이슈에서 PR.
- 견인력: OpenHands 약 93k 별, MIT, 2026-11-12 push. Kiro는 유료 플랜 필요, 벤더 사례 한 건(CBMC의 PR 64건 중 16건 병합)만 확인. Factory는 마케팅 자료 위주.
- 특징: 라벨/멘션 트리거(Kiro, OpenHands); OpenHands는 로컬, Docker, VM, 클라우드 백엔드의 오픈 코어; Factory는 클라우드/하이브리드/온프렘
- MAO 시사점: 라벨 트리거 + 코멘트 청취는 MAO의 auto-trigger(모든 새 이슈 자동 enqueue)보다 안전하고 표준적인 트리거 모델이다.

### Claude+Codex 교차 리뷰 커뮤니티 skill 모음 — 교차 벤더 리뷰 (인접) [partially-verified]
- URL: https://github.com/johnpsasser/codex-pr-review
- 무엇: codex-pr-review, cross-review, cross-model, cross-model-review, review-loop 등 Claude Code와 Codex가 서로 diff를 리뷰하는 skill/도구들. 일부는 두 모델을 병렬로 돌린 뒤 서로의 지적을 소스와 대조한다.
- 견인력: 별 수와 유지 상태는 확인하지 못했다.
- 특징: 다른 모델 계열의 상관되지 않은 두 번째 의견; review-loop은 Claude 서브에이전트와 Codex가 병렬 리뷰 -> 중복 제거 -> 수정 -> 깨끗해질 때까지 반복(worktree 격리, push 안 함)
- MAO 시사점: MAO의 maker-checker 개념이 개발자 커뮤니티에서 이미 수요가 있고 skill 수준으로 구현되고 있다. 다만 이슈->머지 전 구간에서 강제하는 것은 아니다.; 'Claude/Codex 발견 항목 분류 + 소스 대조'는 오탐을 줄이는 방법으로 참고할 만하다.

## 트렌드

- **병렬 에이전트 + worktree 격리가 기본 틀이 되고 앱 시장은 포화/통합 중** — 근거: Emdash, Paradev, Conductor, Sculptor, cmux, Codex 앱, Antigravity 2.0, Cursor Agents 창이 모두 작업당 worktree/VM을 쓴다. Vibe Kanban 종료(2026-04), Crystal -> Nimbalyst 피벗(2026-02), Terragon 종료. → 시사점: 'worktree로 병렬 실행'은 차별점이 아니다. 앱 자체보다 파이프라인 규칙(maker-checker, 게이트)을 제품의 핵심으로 내세워야 한다.
- **플랫폼이 멀티 벤더 에이전트 컨트롤 플레인으로 이동** — 근거: GitHub Agent HQ가 Copilot, Claude, Codex에 이슈를 할당하고 PR에서 @Claude/@Codex 후속 요청을 받는다(공개 프리뷰, 2026-02). Emdash/Conductor/Paradev는 로컬에서 같은 일을 한다. → 시사점: '여러 벤더를 한 화면에서'는 더 이상 새롭지 않다. 벤더 간 정책(교차 리뷰 강제)과 감사 가능성이 차별점이다.
- **리뷰 -> 자동 수정 폐루프의 상용화, 단 리뷰는 대체로 비차단** — 근거: Cursor Bugbot Autofix(2026-02), Devin Autofix(2026-02), Claude PR auto-fix와 Code Review(승인/차단 안 함), Copilot Agent Merge(Watch and fix), Codex 자동 리뷰. → 시사점: MAO에 수정 루프가 없는 것은 명백한 격차다. 비차단 리뷰 자체는 업계 관행이지만 MAO는 머지 단계가 사람 없이 그대로 진행된다는 점이 다르다.
- **가드레일이 제품 기능으로 표준화(권한자만 트리거, 자기 PR 승인 불가, CI 승인, 방화벽, 단일 브랜치)** — 근거: Copilot: 쓰기 권한자만, 요청자 승인 불가, 에이전트는 머지 불가, 워크플로 수동 승인. Claude Action: 쓰기 권한 필요, 봇 거부. Claude 클라우드: 자격증명 프록시, 제한 네트워크. → 시사점: 작성자 게이팅 없는 auto-trigger, 평문 토큰, 샌드박스 없음은 비교 시 가장 눈에 띄는 보안 약점이다.
- **원격/모바일 감독과 알림이 핵심 수요** — 근거: Happy 약 24.6k 별, cmux 약 28.8k 별(알림 터미널), Paradev iOS 앱, Claude Remote Control/모바일, Copilot 원격 제어. → 시사점: 스트리밍 출력과 알림이 없는 폴링 GUI는 격차이며, 개선 시 체감 효과가 크다.
- **이슈 소스 다양화와 라벨/멘션 트리거** — 근거: Emdash가 이슈 트래커 10종 연동, Kiro/OpenHands는 라벨, Factory는 Linear/Jira. → 시사점: GitHub 전용에 모든 새 이슈 자동 enqueue 구조는 좁고 위험하다. 명시적 라벨 옵트인이 업계 관행이다.

## 이용자 니즈

- [여러 CLI 에이전트를 병렬로 돌리는 개인 개발자] 실행 중 상태 한눈에 보기, 대기/완료 알림, diff 인라인 코멘트로 에이전트에 피드백 — 근거: Vibe Kanban의 인라인 diff 코멘트, Emdash/Paradev의 상태 표시와 알림, cmux와 Happy의 인기(각 약 28.8k, 24.6k 별). — MAO 적합도: 약함. 상태/알림/스트리밍이 없고 인라인 피드백 루프도 없다.
- [코드 품질을 걱정하는 팀 리드/메인테이너] 작성 에이전트와 다른 눈의 검증, 자기 승인 방지, 사람 승인 지점 — 근거: Copilot의 자기 PR 승인 금지와 머지 불가, Claude/Codex 교차 리뷰 커뮤니티 skill, Agent HQ의 역할 분담 리뷰 권장. — MAO 적합도: 개념은 정확히 맞지만(maker-checker) 구현이 약하다. 리뷰어가 diff를 못 보고 리뷰가 머지를 막지 못한다.
- [보안/컴플라이언스 민감 조직] 권한자만 트리거, 네트워크 제한, 자격증명 보호, 감사 로그 — 근거: Copilot 방화벽/단일 브랜치/워크플로 승인, Claude 클라우드 자격증명 프록시, GitHub 엔터프라이즈 에이전트 허용 정책. — MAO 적합도: 현재 부적합. 평문 토큰, 클론 URL 토큰, 작성자 게이팅 없음.
- [여러 AI 구독을 가진 파워 유저] 벤더 중립, 기존 구독 재사용(BYOK/로컬 CLI), 벤더 종속 회피 — 근거: Happy('기존 구독 재사용'), Paradev('모델 호출 프록시 안 함'), Emdash의 다중 CLI 지원. — MAO 적합도: 좋음. BYOK와 로컬 CLI 지원은 일치한다. 단, 비슷한 앱이 이미 많다.
- [이미 GitHub 중심으로 일하는 팀] 이슈를 할당하면 PR이 오는 흐름, 비교용 다중 에이전트 배정 — 근거: Agent HQ가 Copilot/Claude/Codex 동시 할당 제공, 라벨 트리거(Kiro, OpenHands). — MAO 적합도: 중복. 로컬 우선이라는 이유 없이는 플랫폼이 이긴다.

## 권고

- (P0/now) **리뷰어가 실제 diff를 보게 한다 (스테이지 프롬프트에 PR diff, 이슈 본문, CI 결과 주입)** — maker-checker는 검토자가 증거를 볼 때만 의미가 있다. 경쟁 리뷰 제품(Claude Code Review, Codex 리뷰, Bugbot)은 모두 diff와 주변 코드를 읽고, 심지어 검증 단계로 오탐을 줄인다. 현재는 제목만 받으므로 사실상 리뷰가 아니다. [출처: Claude Code Review(다중 에이전트 + 검증 단계), Codex @codex review(AGENTS.md 규칙, P0/P1만)]
- (P0/now) **리뷰 결과를 머지 게이트로 만든다 (구조화된 승인/요청 변경 판정, 사람 승인 옵션)** — 업계 리뷰는 대개 비차단이지만 Copilot은 에이전트의 머지 자체를 금지하고 사람이 ready/머지한다. MAO는 CI가 초록이거나 없으면 그냥 머지한다. 최소한 '리뷰 판정 실패 시 중단'과 '머지는 사람 승인' 모드가 필요하다. [출처: GitHub Copilot 클라우드 에이전트(에이전트는 PR을 ready/승인/머지 불가, 요청자 자기 승인 불가)]
- (P0/now) **auto-trigger에 작성자/라벨 게이팅 추가 (쓰기 권한자만, 명시적 라벨 옵트인)** — 공개 저장소에서 아무나 만든 이슈가 도구 권한이 있는 에이전트의 입력이 된다. Copilot과 Claude Action은 쓰기 권한자만 트리거를 허용하고, Kiro와 OpenHands는 라벨/멘션 옵트인을 쓴다. [출처: Copilot 클라우드 에이전트, anthropics/claude-code-action(Who can trigger runs), Kiro/OpenHands 라벨 트리거]
- (P1/next) **리뷰 -> 수정 -> 재리뷰 루프 (PR 리뷰 코멘트를 작성 에이전트에게 되돌림, 횟수 상한)** — Devin Autofix, Bugbot Autofix, Claude auto-fix, Copilot Watch and fix가 모두 이 루프를 제공한다. Cursor는 Autofix 변경의 35% 이상이 병합된다고 공개한다. MAO 메인 엔진만 단방향이다. swarm 모드에는 이미 개정 사이클이 있으므로 설계 재사용이 가능하다. [출처: Cursor Bugbot Autofix, Devin Autofix, Claude Code PR auto-fix]
- (P1/next) **벤더 교차 maker-checker를 강제 규칙으로 부각하고 측정한다 (같은 벤더 계열 제외, 계열 단위 판정, 위반 시 명시적 실패)** — 현재 provider 단위 제외는 같은 벤더의 두 설정을 서로 다른 것으로 취급할 수 있다. 커뮤니티 skill들이 교차 모델 리뷰의 수요를 보여주지만 파이프라인 전체에서 강제하는 제품은 조사 범위에서 못 찾았다. 가장 방어 가능한 차별점이므로 '벤더 계열' 개념과 지표(교차 리뷰가 잡은 결함 수)가 필요하다. [출처: codex-pr-review, review-loop 등 교차 리뷰 skill, GitHub Agent HQ의 역할 분담 리뷰 가이드]
- (P1/next) **벤더 클라우드 에이전트 감독 어댑터 (이슈를 GitHub에서 Copilot/Claude/Codex에 할당하고 PR 상태만 관찰, 로컬 CLI와 병행)** — 플랫폼이 이슈 -> PR 실행을 상용화했으므로 MAO는 실행 대신 감독/교차 리뷰/게이트 계층으로 위치를 잡는 편이 방어 가능하다. 단 Agent HQ는 Pro+/Enterprise 유료 프리뷰이고 인터페이스가 바뀔 수 있어 읽기 전용 관찰부터 시작한다. [출처: GitHub Agent HQ, Claude Code 클라우드 세션, Jules, Devin]
- (P1/next) **실행 중 스트리밍 출력, 상태 표시, 완료/대기 알림 (에이전트 hook 또는 stdout 스트림 기반)** — Emdash는 lifecycle hook으로 상태, 알림, 재개를 추적하고 Paradev는 working/done/waiting을 표시한다. cmux와 Happy의 규모가 알림 수요를 보여준다. MAO는 폴링과 완료 후 출력뿐이다. [출처: Emdash(hook 기반 상태/알림), Paradev(에이전트 상태), cmux(알림 터미널)]
- (P1/next) **자격증명과 실행 격리 개선 (토큰을 OS keychain으로, 클론 URL에서 제거, 네트워크/파일 샌드박스 옵션)** — Emdash는 자격증명을 OS keychain에 저장하고, Claude 클라우드는 자격증명을 VM 밖 프록시로 숨기며, Copilot은 방화벽을 쓴다. MAO는 평문 저장과 URL 임베딩, 권한 확인 우회 실행이다. [출처: Emdash(keychain), Claude Code 클라우드(자격증명 프록시), Copilot(방화벽)]
- (P2/later) **이슈 소스와 트리거 확장 (라벨 기반 트리거, Linear/Jira 어댑터), 그리고 선택적 모바일/원격 승인** — Emdash는 이슈 트래커 10종 연동, Factory는 Linear/Jira를 지원한다. 모바일/원격 승인 수요는 Happy(24.6k 별), Paradev iOS가 보여준다. 다만 1인 메인테이너에게는 비용이 크므로 라벨 트리거 외에는 후순위다. [출처: Emdash 이슈 연동, Factory Linear 통합, Happy/Paradev 모바일]
- (P2/later) **서명된 빌드와 배포 채널 (npm 패키지, Homebrew cask, 자동 업데이트)** — Emdash는 brew cask와 3개 OS 설치본, Paradev와 Conductor는 빠른 릴리스를 낸다. 서명 없는 단일 릴리스는 채택 장벽이다. 기능 격차보다 후순위지만 도입 경로로서 필요하다. [출처: Emdash(brew cask, Windows/Linux 설치본), Vibe Kanban(npm 패키지)]

## 질문별 답

1. (1) MAO에 없는 테이블 스테이크스 기능. 확인한 경쟁 제품들이 대체로 갖춘 것은 다음과 같다. 첫째, 리뷰어가 diff와 주변 코드를 읽는 것(Claude Code Review, Codex 리뷰, Bugbot). 둘째, 리뷰 결과에 따른 수정 루프(Devin/Bugbot Autofix, Claude PR auto-fix, Copilot Watch and fix). 셋째, 트리거 게이팅(Copilot과 Claude Action은 쓰기 권한자만, Kiro/OpenHands는 라벨/멘션). 넷째, 자기 PR 승인 금지와 머지 시 사람 승인(Copilot). 다섯째, 격리/네트워크 제한과 자격증명 보호(Copilot 방화벽, Claude 클라우드 프록시, Emdash keychain). 여섯째, 실시간 상태, 알림, 트랜스크립트 조종(Emdash, Paradev, Claude agent teams). 일곱째, 인라인 diff 코멘트를 에이전트에 보내기(Vibe Kanban). 여덟째, 모바일/원격 접근(Happy, Paradev, Claude Remote Control). 비용 추적은 이번 조사에서 경쟁사별 근거를 충분히 확인하지 못했다.
2. (2) 이미 플랫폼의 상품 기능이 된 MAO 파이프라인 부분. issue -> PR 자동 생성(Copilot 클라우드 에이전트, Claude Action, Jules, Devin, Kiro, OpenHands), 이슈를 여러 벤더 에이전트에 할당(Agent HQ), PR 자동 리뷰(Claude Code Review, Codex, Bugbot, Copilot), 리뷰 코멘트 자동 수정, CI 실패 자동 수정(Agent Merge, auto-fix), worktree/VM 병렬 실행, 스케줄/이벤트 자동화(Codex Automations, Copilot Automations, Paradev 자동화). 즉 '이슈 -> PR -> 리뷰' 자체는 상품화됐고, 남은 것은 머지 정책, 교차 벤더 규칙, 로컬 우선성이다.
3. (3) 독립적이고 로컬 우선인 멀티 벤더 오케스트레이터만 할 수 있는 것. 벤더 한 곳은 자사 모델의 상관 오류를 가진 에이전트로 작성과 리뷰를 모두 하려 하므로(Claude의 Code Review는 Claude 모델만 쓴다고 문서에 나온다) 다른 벤더의 에이전트를 리뷰어로 강제하는 정책 계층은 벤더가 팔기 어렵다. 또한 코드를 외부 클라우드에 올리지 않는 실행, BYOK/기존 구독 재사용, 벤더 종속 없는 감사 기록이 있다. 교차 벤더 maker-checker를 하는 곳이 있는가: 이번 조사에서는 파이프라인 규칙으로 강제하는 제품을 찾지 못했다. Claude Code 안에서 Codex로 교차 리뷰하는 커뮤니티 skill(codex-pr-review, review-loop, cross-review 등)과 Agent HQ의 '같은 작업을 여러 에이전트에 배정해 비교, 역할 분담 리뷰' 가이드가 가장 가깝다. 다만 이는 부재의 증명이 아니라 검색 범위 내 결과이며, 이 skill들의 활성도는 확인하지 못했다.
4. (4) 벤더 클라우드 에이전트를 감독해야 하는가: 예, 단 단계적으로. 근거는 두 가지다. 플랫폼이 이슈 -> PR 실행을 이미 제공하고 가드레일이 MAO보다 강하므로 MAO가 같은 실행을 직접 하는 것은 경쟁력이 낮다. 반면 Agent HQ는 이슈를 Copilot, Claude, Codex에 할당하고 PR 코멘트로 후속 작업을 요청하게 하므로 GitHub 이슈/PR이라는 기존 소통 채널만으로 감독이 가능하다(MAO의 기존 설계와도 맞는다). 권장 순서는 읽기 전용 관찰(PR 상태, 체크, 에이전트 로그 링크), 그다음 교차 리뷰어 배정(다른 벤더를 리뷰어로 호출), 마지막에 게이트. 주의점은 Agent HQ의 Claude/Codex가 공개 프리뷰이고 Pro+/Enterprise 필요(GA 공지는 못 찾음)라 사용자 범위가 좁고 API가 바뀔 수 있다는 것이다. 또 이 방식은 개별 PR에 대한 MAO의 통제력이 약해진다.
5. (5) 벤치마크할 가치가 큰 10가지 순위. 1) Claude Code Review와 Codex 리뷰의 리뷰 입력과 검증 단계(diff 읽기, 오탐 제거, 심각도). 2) GitHub Copilot 클라우드 에이전트의 가드레일 세트(쓰기 권한자만, 자기 승인 금지, 머지 금지, 워크플로 승인, 단일 브랜치). 3) Cursor Bugbot Autofix와 Devin Autofix의 리뷰 -> 수정 루프와 병합률 지표. 4) GitHub Agent HQ의 다중 에이전트 할당/비교와 PR 코멘트 후속 요청 UX. 5) Emdash의 hook 기반 상태/알림/재개와 이슈 소스 연동 폭. 6) Claude Action의 트리거 모델(쓰기 권한, 봇 거부, allowed_bots)과 클라우드 세션의 자격증명 프록시/네트워크 제한. 7) Kiro/OpenHands의 라벨/멘션 트리거와 코멘트 청취. 8) Vibe Kanban의 diff 인라인 코멘트 -> 에이전트 전달 상호작용(현재는 커뮤니티 유지). 9) Paradev의 PR 창(체크, 리뷰 스레드, 머지)과 모바일/원격 앱, 자동화. 10) 커뮤니티 교차 리뷰 skill(codex-pr-review, review-loop)의 교차 모델 대조 방식과 Claude agent teams의 훅 기반 품질 게이트.

## 출처

- https://github.com/generalaction/emdash — Emdash README(지원 에이전트, 이슈 소스, SSH 원격), gh api 별/릴리스(v1.2.11, 2026-11-06)
- https://github.com/ParadevAI/Paradev — Paradev(구 Superset) README와 gh api(약 16.2k 별, desktop-v2.0.8)
- https://vibekanban.com/blog/shutdown — Vibe Kanban 회사 종료(2026-04-10)와 커뮤니티 유지 전환
- https://github.com/BloopAI/vibe-kanban — Vibe Kanban README(sunsetting 배너, 기능), gh api
- https://www.conductor.build — Conductor 지원 에이전트(Claude Code, Codex, Cursor), 최신 0.94.0
- https://github.com/manaflow-ai/cmux — cmux 설명과 gh api(약 28.8k 별, v0.65.2.2)
- https://github.com/smtg-ai/claude-squad — Claude Squad gh api(약 8.8k 별, AGPL-3.0, 마지막 push 2026-08-20)
- https://github.com/imbue-ai/sculptor — Sculptor README(연구 프리뷰)와 gh api
- https://github.com/stravu/crystal — Crystal 폐기와 Nimbalyst 이전(2026-02)
- https://github.com/slopus/happy — Happy gh api 설명과 별 수(약 24.6k)
- https://github.com/omnara-ai/omnara — Omnara gh api 설명
- https://github.com/terragon-labs/terragon-oss — Terragon 'formerly' 상태와 설명
- https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent — Copilot 클라우드 에이전트 환경, 한도, 최근 기능(Agent Merge, Automations 등)
- https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations — Copilot 가드레일(쓰기 권한자, 방화벽, 단일 브랜치, 자기 승인 금지, 워크플로 승인)
- https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/ — Agent HQ에서 Claude/Codex 할당(2026-02-04), Pro+/Enterprise, 프리미엄 요청 1건
- https://github.blog/changelog/2026-04-14-model-selection-for-claude-and-codex-agents-on-github-com/ — Claude/Codex 에이전트 모델 선택(검색 결과 요약 기준, 직접 열람 안 함)
- https://code.claude.com/docs/en/github-actions — Claude Code GitHub Action 트리거와 권한(쓰기 권한, 봇 거부)
- https://code.claude.com/docs/en/code-review.md — 관리형 Code Review(다중 에이전트, 검증, 비차단)
- https://code.claude.com/docs/en/claude-code-on-the-web.md — 클라우드 세션, 자격증명 프록시, PR auto-fix
- https://code.claude.com/docs/en/agent-teams — agent teams(실험적, 기본 꺼짐, 훅 품질 게이트)
- https://learn.chatgpt.com/docs/third-party/github — Codex @codex review, 자동 리뷰, AGENTS.md 리뷰 규칙
- https://openai.com/index/introducing-the-codex-app/ — Codex 앱 소개(검색 결과로만 확인, 세부 날짜는 제3자 기준)
- https://cursor.com/blog/bugbot-autofix — Bugbot Autofix(검색 결과 요약 기준)
- https://cognition.ai/blog/closing-the-agent-loop-devin-autofixes-review-comments — Devin Autofix(검색 결과 요약 기준)
- https://thenextweb.com/news/google-antigravity-2-desktop-cli-sdk-io-2026 — Antigravity 2.0(검색 결과 요약 기준)
- https://kiro.dev/docs/autonomous-agent/github/ — Kiro 라벨/멘션 트리거(검색 결과 요약 기준)
- https://docs.all-hands.dev/usage/cloud/cloud-issue-resolver — OpenHands 라벨/멘션 트리거(검색 결과 요약 기준)
- https://github.com/johnpsasser/codex-pr-review — Claude Code에서 Codex로 교차 리뷰하는 skill 사례(검색 결과 기준)
- https://github.com/AppLoidx/review-loop — Claude+Codex 병렬 리뷰/수정 반복 skill(검색 결과 기준)

## 확인하지 못한 것
約 30회의 도구 호출 예산 안에서 조사했으며 다음은 확인하지 못했다. (a) Conductor 가격과 별 수(출처 충돌/비공개), Conductor의 PR 흐름. (b) Cursor, Devin, Jules, Kiro, OpenHands, Factory, Antigravity는 검색 결과 요약만 보았고 공식 페이지를 직접 열람하지 않아 'partially-verified'다. Devin과 Jules 가격은 제3자 자료이며 서로 충돌한다. (c) Codex 앱의 날짜(Windows, ChatGPT 병합, Linux)는 제3자 블로그 기준이며 OpenAI 공식 changelog를 확인하지 못했다. 공식 문서는 누가 @codex를 트리거할 수 있는지도 밝히지 않았다. (d) Agent HQ의 Claude/Codex가 GA인지는 찾지 못했고(가장 최근 자료 2026-04), 요금 및 세부 제한은 시점에 따라 달라질 수 있다. (e) Antigravity가 Claude/Codex를 지원하는지, Zed, Warp, Sweep, Async, ccmanager, Automaker의 상세는 이번에 조사하지 않았다(ccmanager 약 1.3k 별, Automaker 약 3.2k 별은 gh api로만 확인). (f) '크로스 벤더 maker-checker를 강제하는 제품이 없다'는 결론은 검색 범위 내 결과일 뿐 부재의 증명이 아니다. 커뮤니티 skill들의 별 수와 유지 상태도 확인하지 못했다. (g) cmux 라이선스는 NOASSERTION이고 Claude Squad는 AGPL-3.0으로 사용 조건이 다르다. (h) 요청한 superset-sh/superset은 ParadevAI/Paradev로 이름이 바뀐 것으로 gh api가 반환했다. (i) 웹 검색은 미국 한정이며 한국어권 제품은 거의 다루지 못했다.
