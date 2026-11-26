# 리서치 원자료: AI 리뷰·머지 거버넌스와 오케스트레이션 패턴

> 2026-11-12 조사. 하위 에이전트가 웹에서 수집한 결과를 편집 없이 실었습니다.
> 항목의 [verified] / [partially-verified] / [recalled]는 조사 당일 1차 출처를 직접 열어 확인했는지를 뜻합니다.
> 수치와 제품 상태는 빠르게 바뀝니다. 인용하기 전에 출처를 다시 확인하십시오. 요약은 [benchmarking.md](../benchmarking.md)와 [user-needs.md](../user-needs.md)에 있습니다.

## 요약
결론: 2026년 AI 리뷰 시장의 합의는 (1) 리뷰어는 작성자와 컨텍스트를 공유하지 않는 새 세션이어야 하고, (2) 리뷰는 diff 이상의 저장소 컨텍스트와 실행 증거를 가져야 하며, (3) 후보 지적을 검증 단계로 걸러 오탐을 통제하고, (4) 대부분의 제품은 기본값으로 '댓글만' 달며 승인·차단 권한은 사람 또는 명시적 옵트인 설정에 남긴다는 것입니다. MAO의 현재 review는 제목만 보는 단일 코멘트이므로 이 기준에 크게 못 미칩니다. 'maker-checker'는 학술적으로 부분 지지됩니다. 자기귀속 편향(self-attribution bias, arXiv 2603.04582)은 같은 컨텍스트에서 자기 행동을 평가할 때 나타나고, 블라인드 평가에서는 자기선호가 사라진다는 연구도 있습니다. 즉 이점은 '다른 벤더'보다 '새 컨텍스트 + 저자 비공개'에서 더 확실히 나옵니다. 따라서 주장을 '서로 다른 provider 보장'에서 '분리된 컨텍스트의 독립 검증 단계 + 가능하면 다른 모델'로 재정의하고, 실제 보장은 GitHub 규칙(ruleset)·CI 같은 결정적 게이트가 맡도록 해야 합니다. 오케스트레이션은 Cognition(2026-04)과 Anthropic 모두 '쓰기는 단일 스레드, 읽기/검증은 병렬'로 수렴했습니다. MAO의 고정 선형 파이프라인은 방향이 맞고, 부족한 것은 계획·수정 루프·검증 단계입니다. 범용 그래프 엔진이 아니라 작은 상태기계에 revision 루프를 추가하는 편이 맞습니다. 내구성은 JSON 큐를 당장 Temporal로 바꾸기보다 단계별 멱등성·체크포인트·SQLite 전환이 우선입니다.

## 조사 대상

### Claude Code Review (Anthropic 관리형) — AI 코드 리뷰 [verified]
- URL: https://claude.com/resources/articles/code-review
- 무엇: PR이 열리면 에이전트 팀이 병렬로 버그를 찾고, 검증 단계에서 오탐을 거른 뒤 심각도 순으로 정렬해 개요 코멘트 1개와 인라인 코멘트를 남기는 관리형 리뷰어입니다.
- 견인력: Team/Enterprise 연구 프리뷰. 자사 수치: 실질 리뷰 코멘트 비율 16%에서 54%, 지적의 1% 미만이 부정확(내부 수치이며 독립 검증 없음). 평균 약 20분, 리뷰당 약 15-25달러(2차 출처 포함).
- 특징: 병렬 탐색 후 검증 에이전트로 오탐 제거; 심각도 랭킹; PR을 승인하지 않음. 승인은 사람 몫이라고 명시; 조직 월 지출 상한, REVIEW.md/CLAUDE.md로 리뷰 초점 조정
- MAO 시사점: review는 '탐색 후 검증'의 2단계로 설계한다; 리뷰 비용 상한과 PR 크기별 깊이 조절이 필요하다; 승인 권한을 AI에 주지 않는 설계가 업계 기본값이다

### GitHub Copilot code review — AI 코드 리뷰 [verified]
- URL: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review
- 무엇: GitHub 내장 AI 리뷰어. 기본은 'Comment' 리뷰이며 필수 승인 수에 포함되지 않습니다. 에이전트형으로 Actions 러너에서 도구(MCP 포함)를 호출해 컨텍스트를 모읍니다.
- 견인력: GitHub 공식 기능. 승인(Approve) 기능은 기본 꺼짐이며 enterprise/org/repo 단위로 켭니다.
- 특징: 새 push 자동 재리뷰는 ruleset의 'Review new pushes'를 켜야 동작; 승인 후 새 커밋이 push되면 승인이 해제됨; head 브랜치의 AGENTS.md, CLAUDE.md, REVIEW.md, .github/copilot-instructions.md를 읽음; 경로별로 어떤 Copilot 승인이 인정되는지 제어
- MAO 시사점: AI 리뷰의 기본 권한은 '댓글'이고, 승인으로 올리려면 명시적 정책이 필요하다; stale-approval 해제(새 커밋 시 무효화)를 MAO도 모방해야 한다; MAO가 CLAUDE.md/AGENTS.md를 리뷰 컨텍스트로 읽는 것은 업계 관행과 일치한다

### Cursor Bugbot — AI 코드 리뷰 [partially-verified]
- URL: https://cursor.com/blog/bugbot-learning
- 무엇: Cursor의 PR 리뷰어. 해결률(resolution rate: 머지 시점에 작성자가 실제로 고친 지적의 비율)을 핵심 지표로 쓰고, 반응과 댓글에서 학습 규칙을 만듭니다. Autofix는 클라우드 에이전트로 수정까지 시도합니다.
- 견인력: 자사 수치로 해결률 약 70-80%(게시물마다 52%에서 70%, 76%, 78%, 약 80%로 달라짐). 학습 기능은 11만 개 이상 저장소에서 사용, 학습 규칙 4만 4천 개 이상.
- 특징: 학습 규칙 자동 승격·비활성화; Autofix 재시도 3회 상한(2차 출처); 8패스+다수결+검증 모델 구조라는 설명은 3자 글이며 미확인
- MAO 시사점: '해결률'은 정밀도가 아니라 행동률이라 지표로 쓸 때 한계를 명시해야 한다; 피드백에서 규칙을 학습하는 루프는 장기 차별점이지만 지금 MAO에는 이르다; 자동 수정에는 재시도 상한이 필수다

### Martian Code Review Bench — 독립 벤치마크 [partially-verified]
- URL: https://www.greptile.com/content-library/greptile-martian-code-review-benchmark
- 무엇: 오프라인(실제 버그 도입 PR 50개, 정답 173건)과 온라인(실제 PR에서 개발자가 반영한 코멘트 비율) 두 트랙으로 리뷰 도구를 비교하는 공개(MIT) 벤치마크입니다.
- 견인력: 2026-07-30 리더보드에서 Greptile이 F1 약 60.8%(정밀도 76.2%, 재현율 50.6%)로 1위라는 보도가 있습니다. 그러나 3월 스냅샷에서는 CodeRabbit이 1위(F1 51.5%)였고 트랙마다 순위가 다릅니다. 모두 벤더 인용 경유라 대시보드 직접 확인은 못 했습니다.
- 특징: 데이터셋, 심판 프롬프트, 파이프라인 공개; 의미 매칭으로 정답 대조; F1과 F2 등 지표 선택에 따라 순위가 바뀜
- MAO 시사점: MAO가 리뷰 품질을 주장하려면 자체 소규모 정답셋(자기 PR 이력)과 재현 가능한 채점이 필요하다; 정밀도(오탐)와 재현율은 상충한다. 머지 차단 기준에는 정밀도가 중요하다

### CodeRabbit / Greptile / Qodo Merge(PR-Agent) — AI 코드 리뷰 [partially-verified]
- URL: https://github.com/The-PR-Agent/pr-agent
- 무엇: 상용 리뷰 봇 3종. CodeRabbit은 재현율이 높고 노이즈가 많다는 평이 있고, Greptile은 정밀도가 높다는 평이 있습니다. PR-Agent는 오픈소스 코어입니다.
- 견인력: PR-Agent 저장소 약 1.6만 별(2026-11-12 gh api). 벤더 자체 벤치마크는 서로 모순됩니다. 예: Tenki 테스트에서 CodeRabbit 정밀도 25%, Greptile 15.9%, Copilot 18.9%로 낮고, 자사 도구가 1위입니다.
- 특징: 벤더가 자기 도구를 1위로 두는 벤치마크가 다수; 정밀도와 재현율이 도구마다 반대 방향; PR-Agent는 Apache 계열 오픈소스로 자체 호스팅 가능(라이선스는 미확인)
- MAO 시사점: 벤더 수치는 독립 검증 전에는 인용하지 않는다; PR-Agent를 MAO의 외부 리뷰어 또는 참고 구현으로 병행하는 선택지가 있다

### Self-Attribution Bias 논문 (arXiv 2603.04582) — 리뷰어 독립성 연구 [partially-verified]
- URL: https://arxiv.org/abs/2603.04582
- 무엇: 모니터가 '자기 행동'으로 프레이밍된 행동을 더 올바르고 덜 위험하다고 평가하는 편향을 측정한 2026-03 논문입니다. 코딩 에이전트의 자기 PR 승인과 도구 사용 안전성 판단이 사례입니다.
- 견인력: 초록만 확인. 네 개 코딩·도구 사용 데이터셋에서 이전 assistant 턴의 행동을 평가할 때 고위험·저정확도 행동을 덜 플래그한다고 보고합니다. '내가 썼다'고 명시하는 것만으로는 편향이 생기지 않았다고 합니다. 효과 크기는 본문 미확인.
- 특징: 편향은 같은 대화 턴의 이전 출력일 때 나타남; 고정 예시로 평가한 모니터 신뢰도는 과대평가될 수 있음
- MAO 시사점: 리뷰어는 작성자와 같은 대화에서 이어지지 않는 새 컨텍스트여야 한다; MAO의 '다른 provider' 규칙보다 '새 컨텍스트'가 더 직접적인 근거를 가진다

### Cognition: Don't Build Multi-Agents / Multi-Agents: What's Actually Working — 오케스트레이션 엔지니어링 글 [verified]
- URL: https://cognition.com/blog/multi-agents-working
- 무엇: 2025-06의 '멀티에이전트 만들지 마라'와 2026-04-22 후속편. 후속편은 '쓰기는 단일 스레드, 추가 에이전트는 지능만 기여'하는 설계만 작동한다고 정리합니다.
- 견인력: 자사 수치: Devin Review는 PR당 평균 2건을 잡고 그중 약 58%가 심각. 리뷰 에이전트는 사전 공유 컨텍스트가 없을 때 가장 잘 작동. Claude와 GPT를 함께 쓰는 에스컬레이션이 실제 이득을 냄. 병렬 쓰기 스웜은 채택이 미미.
- 특징: 생성기-검증기 루프: 리뷰어가 diff만 보고 처음부터 검토; 리뷰 지적을 사용자 지시로 필터해 루프와 범위 이탈을 막는 브리지; manager가 child를 띄우는 map-reduce-manage
- MAO 시사점: MAO의 단일 쓰기 선형 구조는 이 결론과 일치한다; 리뷰어에게 작성 컨텍스트를 주지 않는 설계는 장점이며 대신 diff는 반드시 줘야 한다; 리뷰 결과를 작성자에게 되돌리는 필터링된 revision 루프가 핵심 빠진 조각이다

### Anthropic: multi-agent research system — 오케스트레이션 엔지니어링 글 [verified]
- URL: https://www.anthropic.com/engineering/multi-agent-research-system
- 무엇: Opus 리드와 Sonnet 서브에이전트 구성이 단일 Opus보다 내부 리서치 평가에서 90.2% 앞섰다는 글입니다. 토큰이 BrowseComp 성능 분산의 약 80%를 설명하고, 멀티에이전트는 채팅 대비 약 15배 토큰을 씁니다.
- 견인력: Anthropic 자체 평가. 코딩 작업 대부분은 컨텍스트 공유가 필요해 멀티에이전트에 부적합하다고 스스로 명시.
- 특징: 서브에이전트에 목표, 출력 형식, 경계를 명시; 리드가 계획을 외부 메모리에 저장; 실패 지점부터 재개하는 체크포인트와 재시도 결합
- MAO 시사점: 비용 상한과 노력 스케일링 규칙을 둔다; 계획과 상태를 컨텍스트 밖에 저장한다; 성능은 구조보다 토큰 예산에 좌우될 수 있으므로 '멀티'를 성능 근거로 삼지 않는다

### Anthropic: long-running harness — 오케스트레이션 엔지니어링 글 [verified]
- URL: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- 무엇: 초기화 에이전트가 JSON 기능 목록(전부 failing)을 만들고, 이후 세션이 한 번에 한 기능을 구현해 passes만 바꾸며 git 커밋과 진행 노트로 인수인계하는 하네스입니다.
- 견인력: 엔지니어링 글이며 정량 벤치마크 없음.
- 특징: JSON 기능 목록. 모델이 Markdown보다 덜 덮어씀; 세션 시작 시 progress 노트, git log 읽고 기본 E2E 테스트 실행; 단위 테스트·curl만으로는 놓치는 것을 브라우저 자동화 E2E로 확인
- MAO 시사점: 이슈 본문이 아니라 구조화된 acceptance 목록을 단계 간 인수 산출물로 쓴다; 각 단계 시작 시 이전 단계 결과를 실행으로 재검증한다

### OpenAI: Harness engineering — 오케스트레이션 엔지니어링 글 [partially-verified]
- URL: https://openai.com/index/harness-engineering/
- 무엇: 2026-02-11 글. Codex로 약 5개월간 약 100만 줄을 만든 팀이 환경, 의도 명세, 피드백 루프 설계가 인간의 주 업무가 되었다고 설명합니다.
- 견인력: 2차 출처에는 병합 PR 약 1,500건 등의 수치가 있으나 출처마다 불일치(예: 9개월이라는 요약). 본 조사에서는 본문 직접 열람 대신 검색 요약만 확인.
- 특징: 저장소를 시스템 오브 레코드로, 짧은 지도형 지침; 앱의 UI·로그·메트릭을 에이전트가 읽도록 노출; 에이전트끼리 리뷰를 주고받는 루프
- MAO 시사점: 리뷰 컨텍스트에 로그·테스트 결과를 연결하면 '실행으로 검증'이 가능해진다; AGENTS.md를 짧은 지도로 유지하는 MAO의 기존 방향이 맞다

### MAST: Why Do Multi-Agent LLM Systems Fail? — 학술 연구 [partially-verified]
- URL: https://arxiv.org/abs/2503.13657
- 무엇: 7개 멀티에이전트 프레임워크의 1,642개 실행 트레이스를 주석 처리해 14개 실패 모드를 3범주(명세, 에이전트 간 불일치, 검증)로 분류한 NeurIPS 2025 논문입니다.
- 견인력: 주석 신뢰도 Cohen's kappa 0.88(150개 트레이스), LLM 심판 정확도 94%. 멀티에이전트의 벤치마크 이득이 종종 미미하다는 문제의식.
- 특징: 실패 원인의 상당수가 모델이 아니라 시스템 설계; '검증' 범주가 독립된 실패군
- MAO 시사점: 에이전트 수를 늘리기 전에 명세와 검증 단계 실패를 먼저 설계한다

### GitHub Spec Kit / OpenSpec / BMAD / Task Master — 스펙 주도 개발 도구 [partially-verified]
- URL: https://github.com/github/spec-kit
- 무엇: spec-then-implement 계열 도구. Spec Kit은 specify, plan, tasks, implement 흐름의 CLI/슬래시 명령이고, Kiro도 requirements, design, tasks 3단계를 씁니다.
- 견인력: gh api 2026-11-12 기준 별 수: spec-kit 14.9만, OpenSpec 7.5만, BMAD-METHOD 5.5만, claude-task-master 2.8만(마지막 push 2026-04-28로 정체). 비판: 마크다운 과다, 소규모 작업엔 폭포수 느낌, 스펙과 코드의 드리프트. 독립 효과 검증은 찾지 못함.
- 특징: 승인 게이트가 있는 명세 단계; Quick Spec 같은 게이트 생략 모드; 승인된 스펙은 요구사항이 옳음을 보증하지 않음
- MAO 시사점: 이슈 본문을 그대로 구현하지 않고 짧은 plan/acceptance 산출물을 한 단계 추가하되 무거운 마크다운 체계는 피한다; 별 수는 효과의 증거가 아니다

### Gas Town / Beads — 소프트웨어 팩토리 [recalled]
- URL: https://github.com/gastownhall/beads
- 무엇: Beads는 에이전트용 이슈 트래커형 메모리이고 Gas Town은 그 위의 다중 에이전트 오케스트레이터입니다. 구체 기능은 본 조사에서 README를 열어 확인하지 못했습니다.
- 견인력: gh api: beads 약 2.9만 별, gastown 약 1.9만 별, 둘 다 2026-11 활동 중.
- 특징: 이슈 트래커를 에이전트 메모리로 사용하는 발상; 병렬 에이전트 스웜 지향
- MAO 시사점: GitHub 이슈/PR 자체를 상태와 인수인계 저장소로 쓰는 MAO 설계는 같은 방향이다; 병렬 쓰기 스웜은 Cognition 결론상 유행 쪽이므로 따라가지 않는다

### claude-flow(ruflo) / MetaGPT — 소프트웨어 팩토리 [partially-verified]
- URL: https://github.com/ruvnet/claude-flow
- 무엇: 역할 기반 다중 에이전트 소프트웨어 회사 시뮬레이션 계열. 저장소 이름이 ruflo로 바뀐 것으로 보입니다.
- 견인력: gh api: ruflo 약 8.2만 별, MetaGPT 약 7.1만 별이나 MetaGPT 마지막 push는 2026-01-21로 정체. 효과를 입증한 독립 벤치마크는 찾지 못함.
- 특징: 별 수가 큼에도 검증된 생산성 근거가 부족
- MAO 시사점: 별 수와 역할 시뮬레이션 수에 끌리지 않는다

### 내구 실행 엔진 (Temporal, Inngest, Restate, DBOS) — 내구 실행 [partially-verified]
- URL: https://github.com/temporalio/temporal
- 무엇: 단계별 결과를 저장해 장애 시 실행 중이던 단계만 재개하는 워크플로 엔진군. Temporal이 사실상 표준이고 DBOS는 Postgres 라이브러리 방식입니다.
- 견인력: Temporal 저장소 약 2.4만 별. 'Codex가 Temporal로 하루 수백만 요청 처리'와 '5억 달러 가치' 같은 주장은 2차 블로그 출처라 미확인. LangGraph도 PostgresSaver 체크포인터를 제공한다고 보도.
- 특징: 재시도, 체크포인트, 재개를 런타임이 보장; 대부분 서버 또는 DB 의존성을 요구
- MAO 시사점: 데스크톱 앱과 로컬 CLI인 MAO에는 서버형 엔진이 과하다; 개념(단계 로그, 멱등 키, 재개)만 가져온다

### 에이전트 프레임워크 (LangGraph, CrewAI, AG2, Microsoft Agent Framework, OpenAI Agents SDK, Google ADK) — 오케스트레이션 프레임워크 [partially-verified]
- URL: https://github.com/langchain-ai/langgraph
- 무엇: 그래프/역할/핸드오프 추상화를 제공하는 Python 중심 프레임워크들.
- 견인력: gh api 2026-11-12: LangGraph 4.5만, CrewAI 6.1만, openai-agents-python 3.1만, google adk-python 2.2만, microsoft/agent-framework 1.5만, ag2 5천 별. 모두 활발히 push 중. 본 조사에서는 각 문서를 열어보지 않음.
- 특징: 체크포인트 내장이 수렴 추세; Python 중심이라 TypeScript 코어와 직접 결합이 어렵다
- MAO 시사점: 프레임워크 도입보다 MAO의 작은 상태기계 유지가 낫다. 개념은 참고만 한다

## 트렌드

- **리뷰어는 기본적으로 '댓글만', 승인은 옵트인 또는 사람** — 근거: Copilot은 기본 Comment 리뷰이며 필수 승인에 불포함, Approve는 기본 꺼짐이고 새 커밋 시 해제(GitHub docs). Claude Code Review는 'PR을 승인하지 않는다'고 명시(claude.com). → 시사점: MAO의 review 코멘트가 머지를 막지 못하는 것은 업계 기본과 같지만, 머지 단계가 그 결과를 읽지도 않는 점이 문제입니다. 구조화된 판정을 머지 조건에 연결해야 합니다.
- **탐색 후 검증의 2단계 리뷰와 심각도 랭킹** — 근거: Claude Code Review는 병렬 탐색, 검증, 심각도 정렬을 설명하고, Cursor는 해결률을 최적화 지표로 삼습니다. Cognition은 사전 컨텍스트 없는 리뷰어가 가장 낫다고 보고합니다. → 시사점: 하나의 프롬프트로 코멘트를 쓰는 방식에서 후보 지적 생성, 검증, 심각도 분류의 최소 2패스로 바꿔야 합니다.
- **벤치마크 수치는 벤더 의존적이고 모순적** — 근거: Martian 스냅샷의 1위가 시점에 따라 CodeRabbit과 Greptile로 달라지고, Tenki 같은 벤더 벤치마크는 자사를 1위로 둡니다. Cursor의 해결률은 게시물마다 70-80%로 달라집니다. → 시사점: 외부 수치를 MAO 문서에 근거로 쓰지 말고, 자체 소형 정답셋과 재현 가능한 채점 스크립트로 주장합니다.
- **쓰기는 단일 스레드, 병렬은 읽기·검증에** — 근거: Cognition 2026-04: 병렬 쓰기 스웜은 채택이 미미하고 리뷰·에스컬레이션·map-reduce가 작동. Anthropic: 대부분의 코딩 작업은 컨텍스트 공유 때문에 멀티에이전트에 부적합. → 시사점: main 엔진의 직렬 큐는 장점입니다. 병렬화는 구현이 아니라 검증 쪽에만 적용합니다.
- **스펙 주도 개발과 하네스 엔지니어링의 확산, 그러나 독립 효과 증거는 부족** — 근거: spec-kit 14.9만 별 등 gh api. 비판은 마크다운 과다와 스펙 드리프트. OpenAI와 Anthropic은 구조화된 산출물과 E2E 검증 루프를 강조. → 시사점: 계획 단계는 짧은 acceptance 체크리스트 정도로 시작하고, 효과는 자체 이력으로 측정합니다.
- **오픈소스 프로젝트의 AI PR 정책 양극화** — 근거: Godot의 금지(2026-06/07), COSMIC의 무LLM 증명 요구, Ghostty와 Drupal의 공개 의무, tldraw의 외부 PR 자동 닫기, curl의 이슈 연계 없는 AI PR 금지. 대부분 2차 블로그 경유이며 1차 정책 문서는 열람하지 못함. → 시사점: MAO는 이슈를 자동으로 PR로 바꾸는 도구이므로 대상 저장소의 AI 정책을 위반하지 않는 안전장치와 AI 작성 공개 표기가 신뢰 요건이 됩니다.
- **내구 실행 개념이 에이전트 프레임워크로 흡수** — 근거: LangGraph PostgresSaver, OpenAI Agents SDK 재개 프리미티브(블로그 보도), Anthropic도 체크포인트에서 재개. Temporal/Inngest/Restate/DBOS 비교 글이 다수이나 대부분 벤더 인접. → 시사점: 요구는 '재개 가능성과 멱등성'이며 특정 엔진이 아닙니다.

## 이용자 니즈

- [AI 에이전트를 PR 파이프라인에 붙이려는 개인 개발자] AI가 만든 변경을 사람이 쉽게 믿고 검토할 수 있어야 함: 변경 요약, 테스트 결과, 위험 표시 — 근거: Claude Code Review의 심각도 랭킹과 개요 코멘트, Cursor의 해결률 지표가 이 필요를 겨냥합니다(해당 공식 글). — MAO 적합도: 낮음에서 중간. 현재 리뷰어가 diff를 보지 못해 신뢰할 근거를 제공하지 못합니다.
- [오픈소스 메인테이너] AI 슬롭 PR을 거르고, AI 작성 여부 공개를 받는 것 — 근거: Godot, COSMIC, Ghostty, tldraw, curl 정책(2차 출처 다수). — MAO 적합도: MAO는 슬롭 생성 쪽에 서 있을 위험이 있어 PR 본문에 AI 작성 표기, 자동 대량 PR 방지, 대상 저장소 정책 확인이 필요합니다.
- [소규모 팀 리드] 리스크 등급별 자동 머지 정책과 감사 가능한 승인 기록 — 근거: Copilot의 경로별 승인 제어와 stale 승인 해제, GitHub ruleset 기능(공식 docs의 일부만 확인). — MAO 적합도: 낮음. 현재 머지 게이트는 CI 성공 또는 CI 없음뿐입니다.
- [여러 AI 도구를 병행하는 파워 유저(한국어권 포함)] 벤더 간 교차 검증과 도구 간 이식 가능한 산출물(AGENTS.md 등) — 근거: Cognition이 Claude와 GPT 조합 이득을 보고하고, Copilot이 AGENTS.md, CLAUDE.md, GEMINI.md를 읽습니다. — MAO 적합도: 중간. 다중 provider 구조가 이 필요에 맞지만 효과를 입증하지 못했습니다.

## 권고

- (P0/now) **리뷰어에게 실제 diff와 이슈 본문, 변경 파일 컨텍스트를 제공** — 현재 제목만 보는 리뷰는 어떤 신뢰 기준도 충족하지 못합니다. 작성 세션의 컨텍스트는 주지 않되 diff, 이슈, AGENTS.md는 줍니다(Cognition: 사전 컨텍스트 없는 리뷰어가 최선). [출처: Cognition Devin Review, Copilot code review, Claude Code Review]
- (P0/now) **구조화된 리뷰 판정(JSON: verdict, 지적 목록, 심각도, 근거 위치)과 머지 연동** — 코멘트만 달고 머지가 읽지 않으면 maker-checker가 형식에 그칩니다. blocker 심각도 지적이 있으면 머지 단계가 멈추거나 revision으로 돌아가야 합니다. [출처: Claude Code Review(심각도 랭킹), Copilot(Comment/Approve 구분)]
- (P0/now) **리뷰 지적 후 작성자에게 돌아가는 revision 루프(상한 3회, 사람 에스컬레이션)** — 생성기-검증기 루프는 Cognition이 작동한다고 보고한 구조입니다. Bugbot Autofix의 재시도 상한 같은 루프 방지책이 필요합니다. [출처: Cognition 후속편, Cursor Bugbot Autofix, MAO swarm의 revision cycle]
- (P0/now) **실행 증거를 리뷰와 머지 조건에 포함: CI 결과 필수 옵션, 테스트 로그를 리뷰어 입력에 포함** — CI 없음이면 머지되는 현재 정책은 방어하기 어렵습니다. 최소한 CI 없음은 사람 승인 필요로 바꿉니다. [출처: OpenAI harness engineering, Anthropic long-running harness(E2E 검증)]
- (P1/next) **리스크 등급별 머지 정책(문서·테스트만은 자동, 의존성·CI·인증·시크릿 경로는 사람 필수)** — Copilot이 경로별 승인 인정 범위를 제어하는 것과 같은 방식입니다. 기본값은 사람 승인이고 자동 머지는 옵트인입니다. [출처: GitHub Copilot 승인 설정, GitHub rulesets/CODEOWNERS(일반 지식, 이번에 원문 미확인)]
- (P1/next) **maker-checker 주장 재정의와 자체 증거 수집** — 자기귀속 편향 논문은 '같은 컨텍스트'의 위험을 보여주지만, 다른 벤더가 더 낫다는 직접 증거는 약합니다. 주장을 '독립 컨텍스트, 저자 비공개, 가능하면 다른 모델'로 낮추고 자체 PR 이력으로 비교 실험을 합니다. [출처: arXiv 2603.04582, EMNLP 2026 블라인딩 연구(검색 요약만 확인)]
- (P1/next) **AI 작성 공개와 대상 저장소 정책 확인** — PR 본문에 사용 에이전트와 모델을 표기하고, 외부 저장소에서는 기여 정책 파일(AI 금지 여부)을 확인해 금지 시 PR을 열지 않습니다. 슬롭 PR 논란에서 MAO의 평판 위험을 줄입니다. [출처: Godot, COSMIC, Ghostty, Drupal, curl 정책]
- (P1/next) **단계 산출물 인수인계(plan/acceptance JSON)와 선택적 plan 단계** — Anthropic은 JSON 기능 목록이 Markdown보다 덜 덮어써진다고 보고했습니다. 무거운 스펙 체계 대신 짧은 acceptance 체크리스트를 이슈에서 생성해 리뷰어가 대조하게 합니다. [출처: Anthropic long-running harness, Kiro/Spec Kit(경량화 버전)]
- (P1/next) **단계 실행의 멱등성과 체크포인트: createBranch 재시도 충돌 해소, 외부 쓰기의 멱등 키, 큐를 SQLite로** — Temporal 같은 엔진 대신 AGENTS.md에 이미 적힌 알려진 결함(재시도 시 Reference already exists)을 먼저 고치는 것이 가장 비용 대비 효과가 큽니다. [출처: Anthropic multi-agent research(재개 가능성), 내구 실행 엔진 개념]
- (P2/later) **실행당 비용·토큰 상한과 리뷰 깊이 스케일링** — Claude Code Review는 월 상한과 PR 크기별 깊이를 둡니다. MAO는 비용 추적 자체가 없습니다. [출처: Claude Code Review, Anthropic multi-agent research(15배 토큰)]
- (P2/later) **리뷰 품질 자체 평가 하네스(소형 정답셋, 재현 가능 채점)** — 공개 벤치마크는 벤더 의존적이므로 자신의 이력으로 오탐과 누락을 측정해야 문서에 수치를 쓸 수 있습니다. [출처: Martian Code Review Bench의 공개 방법론]
- (P3/later) **피드백 기반 학습 규칙과 병렬 스웜, 범용 그래프 엔진은 보류** — 병렬 쓰기 스웜은 Cognition이 비효율로 평가했고 학습 규칙은 사용자 규모가 있어야 의미가 있습니다. 지금 투자하면 핵심 격차(diff 리뷰)를 미룹니다. [출처: Cognition, Cursor Bugbot learning]

## 질문별 답

1. (1) 리뷰 단계가 신뢰받으려면 최소한 다음을 해야 합니다. 첫째, 작성 컨텍스트와 분리된 새 세션에서 실제 diff, 이슈 본문, 변경 파일 주변 코드와 AGENTS.md를 입력으로 받습니다(Cognition: 사전 컨텍스트가 없는 리뷰어가 최선, Copilot은 head 브랜치의 지침 파일을 읽음). 둘째, 후보 지적을 만든 뒤 별도 검증 패스로 오탐을 거르고 심각도를 매깁니다(Claude Code Review의 구조). 셋째, 자유 텍스트가 아니라 구조화된 판정을 내고 머지 단계가 이를 읽습니다. 넷째, 새 커밋이 push되면 이전 판정을 무효화하고 재리뷰합니다(Copilot의 승인 해제와 'Review new pushes'). 다섯째, 가능하면 테스트·CI 로그 같은 실행 증거를 입력에 넣습니다. 여섯째, 효과 주장은 자체 정답셋으로 측정합니다. 공개된 업계 수치는 벤더 의존적이고 서로 모순됩니다(예: Claude Code Review의 '오탐 1% 미만'은 내부 수치이며 독립 검증이 없음). 확인하지 못한 점: 각 제품의 내부 패스 수와 재리뷰 동작의 상세는 공식 문서로 전부 확인하지 못했습니다.
2. (2) 방어 가능한 자동 머지 정책은 '기본 사람 승인, 낮은 위험만 옵트인 자동 머지'입니다. 구체적으로: 필수 CI 통과(CI 없음은 사람 승인으로 전환), 구조화된 리뷰 판정에 blocker 없음, 리뷰 후 새 커밋이 생기면 승인 무효화, 경로 기반 등급(문서·테스트는 자동 가능, 의존성·CI 설정·인증·시크릿·마이그레이션은 항상 사람), 변경 크기 상한, 연속 revision 실패 시 사람 에스컬레이션, 머지 전 head SHA 고정(현재 알려진 경쟁 상태 해소), 그리고 PR에 AI 작성과 사용 모델을 표기하는 것입니다. 업계 기준선은 Copilot 방식으로, AI 리뷰의 승인은 기본 꺼져 있고 켜더라도 경로별로 인정 범위를 제어합니다. GitHub의 ruleset/branch protection/CODEOWNERS/merge queue가 이 정책을 강제하는 수단이지만, 이번 조사에서 해당 공식 문서 원문(특히 작성자 본인 승인 불가 규칙)은 열람하지 못해 일반 지식 수준입니다. MAO는 스스로 쓴 PR을 승인하는 동일 신원 문제가 있으므로 GitHub 측 보호 규칙을 우회하지 않는 구성이 필요합니다.
3. (3) 근거는 부분적입니다. 지지하는 증거: 자기귀속 편향 논문(arXiv 2603.04582)은 모니터가 같은 컨텍스트의 자기 행동을 덜 위험하다고 평가함을 보였고, Cognition은 사전 컨텍스트 없는 리뷰어가 가장 잘 작동하며 Claude와 GPT 병용이 어려운 사례에서 이득을 줬다고 보고했습니다. 반대·약화 증거: 검색 요약에 따르면 블라인드 평가에서는 자기선호가 사라진다는 EMNLP 2026 Findings 논문, 수정 과제에서 자기선호가 검출되지 않았다는 2026-06 논문, 측정 인공물이라는 주장이 있고, 코딩 에이전트가 자사 코드를 후하게 평가하지 않았다는 블로그도 있습니다(저는 이 논문들을 초록 수준으로도 직접 열지 못했고 검색 요약에 의존했습니다). 따라서 재정의를 권합니다. '서로 다른 AI가 검토한다'가 아니라 '작성 컨텍스트와 저자 정보가 분리된 독립 검증 단계를 거치며, 두 개 이상의 provider가 있으면 다른 모델을 우선한다'로 쓰고, 보장은 provider 규칙이 아닌 CI와 GitHub 규칙 같은 결정적 게이트가 한다고 명시합니다. 단일 provider 폴백 시에는 새 컨텍스트와 저자 비공개만으로도 이점이 있음을 주장하되 한계를 표기합니다. 자체 실험(같은 PR을 동일 모델과 다른 모델이 리뷰해 결함 주입 PR에서 탐지율 비교)으로 수치를 만들기 전에는 '독립성이 품질을 높인다'고 단정하지 않는 것이 안전합니다.
4. (4) 구성 가능한 범용 그래프보다, 고정 골격에 두 개의 닫힌 확장점을 추가한 작은 상태기계를 권합니다. 근거: 현재 증거는 쓰기는 단일 스레드가 안정적이고(Cognition), 대부분의 코딩 작업은 멀티에이전트에 부적합하며(Anthropic), MAST 논문은 실패의 큰 몫이 명세와 검증 설계에 있다고 봅니다. 추가할 것: ① issue/plan(선택, 짧은 acceptance 체크리스트) → pr → review → (blocker가 있으면) revision(pr로 복귀, 최대 N회) → verify(CI/테스트 실행 증거 확인) → merge. ② 단계 정의를 데이터화해서 레포별로 plan·verify를 켜고 끌 수 있게 하되 임의 그래프 분기는 지원하지 않습니다. LangGraph류 도입은 Python 중심이고 MAO의 TypeScript 코어와 맞지 않으며, 얻는 것은 상태기계와 체크포인트 개념뿐입니다. 스펙 주도 개발 도구는 독립적 효과 증거가 없고 마크다운 과다 비판이 있으므로 가볍게만 차용합니다.
5. (5) 지금은 Temporal·Restate·Inngest 같은 별도 서버형 엔진이 맞지 않습니다. 데스크톱/로컬 CLI 도구에 서버 의존성을 얹으며, 현재 문제의 대부분은 엔진 부재가 아니라 단계 부작용의 비멱등성입니다(AGENTS.md에 이미 기록된 createBranch 재시도 충돌, 알림 throw 시 중복 쓰기). 우선순위: 첫째 각 외부 쓰기를 멱등화(존재하면 재사용)하고 단계 로그에 외부 부작용 기록을 남깁니다. 둘째 JSON 단일 파일은 이미 잠금·조건부 쓰기·가드로 상당히 방어되어 있으나 확장하려면 SQLite 같은 임베디드 DB로 옮깁니다(DBOS 방식 개념과도 가까움, 라이브러리형이고 Postgres 의존). 셋째 재개 가능성이 요구되는 장시간 실행이 늘어나면 그때 내구 엔진을 재평가합니다. 엔진 시장 자료(Temporal 대형 투자, Codex가 Temporal 사용 등)는 2차 블로그 출처라 의사결정 근거로 쓰지 않았습니다.
6. (6) 채택할 패턴 10개(순위): 1) 컨텍스트 분리된 독립 리뷰어(새 세션, 저자 비공개). 2) 탐색 후 검증의 2패스 리뷰와 심각도 랭킹. 3) 리뷰 지적을 작성자에게 돌려보내는 상한 있는 evaluator-optimizer revision 루프. 4) 실행에 의한 검증(CI와 테스트 로그를 판정 입력으로, 필요 시 E2E). 5) 리스크 등급별 머지 정책과 사람 게이트(경로 기반). 6) 단계 간 구조화된 인수 산출물(plan/acceptance JSON, 판정 JSON). 7) 외부 쓰기의 멱등성과 체크포인트로 재개 가능한 단계. 8) GitHub 이슈·PR을 상태 저장소로 쓰는 이슈 트래커 메모리(이미 MAO가 보유). 9) 격리 worktree 기반 동시성(이미 swarm에 있음, 쓰기 병렬은 신중히). 10) 실행당 비용·토큰 상한과 노력 스케일링. 피해야 할 유행: 병렬 쓰기 스웜(Cognition은 채택 미미라고 평가), 역할 시뮬레이션형 소프트웨어 회사(MetaGPT·claude-flow류는 별 수가 크지만 독립 효과 증거를 찾지 못함), 무거운 스펙 문서 체계(드리프트와 마크다운 과다 비판), 범용 에이전트 프레임워크 이식, 서버형 내구 엔진 조기 도입, 벤더 벤치마크 수치 인용, 피드백 학습 규칙의 조기 구현. 'ralph 루프'와 Task Master, BMAD 등은 별 수는 확인했으나 효과 근거는 조사하지 못했습니다.

## 출처

- https://cognition.com/blog/multi-agents-working — Cognition 2026-04-22: 쓰기 단일 스레드, 리뷰 루프, Claude+GPT 에스컬레이션, 병렬 쓰기 스웜 미채택
- https://arxiv.org/abs/2603.04582 — Self-Attribution Bias 논문 초록(2026-03-04), 효과 크기는 미확인
- https://www.anthropic.com/engineering/multi-agent-research-system — 멀티에이전트 90.2% 향상, 토큰 15배, 코딩 부적합 언급, 체크포인트 재개
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — JSON 기능 목록, git 체크포인트, E2E 검증, 진행 노트
- https://claude.com/resources/articles/code-review — Claude Code Review: 병렬 탐색, 검증, 심각도, 승인 안 함, 비용, 자체 수치
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review — Copilot 리뷰는 기본 Comment, 승인 옵트인, 새 push 재리뷰 설정, 컨텍스트 파일
- https://cursor.com/blog/bugbot-learning — Bugbot 학습 규칙, 해결률(검색 결과 요약 경유)
- https://www.greptile.com/content-library/greptile-martian-code-review-benchmark — Martian 벤치마크 관련 벤더 글(검색 결과 경유, 수치는 직접 대시보드 확인 못 함)
- https://arxiv.org/abs/2503.13657 — MAST 멀티에이전트 실패 분류(검색 요약 경유)
- https://openai.com/index/harness-engineering/ — OpenAI 하네스 엔지니어링(검색 요약 경유, 본문 직접 열람 못 함)
- https://thenewstack.io/godot-bans-ai-coding-agents/ — Godot AI 코드 금지(2차 출처, 1차 정책 문서 미열람)
- https://github.com/github/spec-kit — gh api 별 수 14.9만(2026-11-12), 같은 방식으로 OpenSpec, BMAD, task-master, gastown, beads, ruflo, MetaGPT, LangGraph, CrewAI, ag2, agent-framework, adk-python, openai-agents-python, pr-agent, temporal 별 수 확인
- https://hackernoon.com/durable-execution-for-ai-agents-langgraph-dbos-inngest-and-temporal-compared — 내구 실행 비교(벤더 인접 2차 출처, 참고만)
- https://businesstechnavigator.com/blog/kiro-spec-driven-development-requirements-design-tasks-aws-2026 — Kiro 3단계 흐름 설명(2차 출처)

## 확인하지 못한 것
예산(약 45회) 중 약 25회만 사용했고 다음은 확인하지 못했습니다. (1) 자기선호 관련 EMNLP 2026 Findings, 2026-06 수정 과제, 2604.22891 논문은 검색 결과 요약만 봤고 원문을 열지 않았습니다. 따라서 '블라인드 시 자기선호 소멸', '수정 과제에서 자기선호 미검출' 같은 서술은 partially-verified 이하입니다. (2) Martian 순위는 벤더 글과 검색 요약 경유이며 리더보드 직접 확인을 못 했고 스냅샷 날짜별로 순위가 다릅니다. Cursor 해결률과 Claude Code Review의 오탐 1% 미만은 모두 자사 수치입니다. (3) GitHub rulesets, branch protection, merge queue, CODEOWNERS, 작성자 본인 승인 불가 규칙은 공식 문서 fetch가 404로 실패해 확인하지 못했고 일반 지식입니다. (4) OSS의 AI PR 정책(Godot, COSMIC, Ghostty, Drupal, curl, tldraw, Rust)은 2차 블로그 요약이며 1차 정책 문서를 열지 않았고 날짜에 불일치가 있습니다. (5) CodeRabbit, Greptile, Qodo Merge의 내부 리뷰 방식, Graphite 리뷰어, Codex 리뷰, Microsoft Agent Framework, Google ADK, CrewAI, AG2, Claude Agent SDK 서브에이전트, Gas Town/Beads, BMAD, OpenSpec, Task Master, ralph 루프, Temporal/Inngest/Restate/DBOS 각 공식 문서는 조사하지 못했습니다. 별 수와 push 날짜만 gh api로 확인했습니다. (6) 첫 morphllm 비교 페이지는 주제와 맞지 않아(2025-01 날짜, 코드 적용 도구 비교) 결과에서 제외했습니다. (7) 내구 실행 시장 수치(Temporal 가치, Codex 사용 규모)는 저품질 2차 출처라 사용하지 않았습니다. (8) 이슈 큐 구현의 MAO 코드 자체는 지시상 이미 알려진 약점을 전제로 했고 이번에 다시 읽지 않았습니다.
