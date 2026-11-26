# 리서치 원자료: 코딩 에이전트 통합과 보안

> 2026-11-12 조사. 하위 에이전트가 웹에서 수집한 결과를 편집 없이 실었습니다.
> 항목의 [verified] / [partially-verified] / [recalled]는 조사 당일 1차 출처를 직접 열어 확인했는지를 뜻합니다.
> 수치와 제품 상태는 빠르게 바뀝니다. 인용하기 전에 출처를 다시 확인하십시오. 요약은 [benchmarking.md](../benchmarking.md)와 [user-needs.md](../user-needs.md)에 있습니다.

## 요약
2026-11-12 기준 오늘 가져온 1차 출처로 확인한 핵심 결론은 네 가지다. (1) 주요 코딩 에이전트 CLI는 모두 JSON/JSONL 스트림, 세션 재개, 권한·샌드박스 플래그를 갖춘 구조화 헤드리스 모드를 제공한다. MAO의 'stdin 프롬프트 + 모든 CLI에 --model/--effort 일괄 부착 + stdout 버퍼링'은 이 표면의 일부도 쓰지 못한다. (2) 2026년의 가장 큰 보안 사건은 'Comment and Control'(4월), Gemini CLI CVSS 10 RCE(4월), GitLost(7월) 같이 이슈·PR·코멘트 텍스트가 CI의 에이전트를 탈취해 비밀을 빼내는 유형이다. 자동 큐잉된 공개 저장소 이슈를 권한 우회 에이전트에 넣는 MAO는 이 위협 모델과 정확히 겹친다. (3) 'skip permissions'는 프롬프트만 끄고 OS 샌드박스는 그대로 두는 것이 Claude Code의 문서화된 설계다. 그러나 MAO는 샌드박스 자체를 켜지 않으므로 현재는 사실상 무방비다. (4) 제어 우선순위는 신뢰 게이팅(작성자·라벨), 토큰 최소권한·단명화, OS 샌드박스+네트워크 allowlist, 에이전트 출력의 비밀 스캔, 리뷰 구속력과 보호 경로 순이다. 어댑터 방향은 에이전트별 구조화 어댑터를 기본으로 하고 ACP 클라이언트를 보편 경로로 추가하는 것이다. MCP 서버 노출은 후순위다. Aider·Goose·Amp·OpenCode 세부 플래그는 이번 조사에서 1차 출처로 확인하지 못했다.

## 조사 대상

### Claude Code CLI + Agent SDK — 에이전트 CLI/SDK [verified]
- URL: https://code.claude.com/docs/en/headless
- 무엇: claude -p 헤드리스 모드와 Python/TS Agent SDK. SDK는 Claude Code 바이너리를 라이브러리로 구동한다.
- 견인력: 확인 불가(수치 미조회)
- 특징: --output-format text|json|stream-json, --json-schema로 structured_output, 결과에 total_cost_usd와 세션 ID; stream-json에 system/init(모델·도구·MCP), system/api_retry(error 분류: rate_limit, overloaded, authentication_failed, billing_error 등), 최종 result 메시지; --resume <session_id>/--continue, --append-system-prompt, --max-budget-usd, --permission-mode(auto/dontAsk/acceptEdits), --permission-prompts none; 종료코드: 성공 0, SIGTERM 143. 인증 실패 같은 런타임 오류는 stdout에 result로 출력; --bare: 훅·플러그인·MCP·CLAUDE.md 자동 로드를 끄는 CI 권장 모드(추후 -p 기본값 예정); --bare 없이 -p로 실행하면 저장소의 .claude/settings.json 훅과 .mcp.json 서버가 신뢰 대화상자 없이 실행된다; SDK 약관: 제3자 제품이 claude.ai 로그인/요금제 한도를 제공하는 것은 사전 승인 없이는 불가. API 키 사용
- MAO 시사점: --effort를 모든 CLI에 붙이지 말고 각 CLI의 실제 플래그 표로 대체한다. 이 문서에서는 claude의 --effort 플래그 자체를 확인하지 못했으므로(/effort 슬래시 명령만 확인) 어댑터 능력 표에 근거를 달아야 한다.; 정액 구독 인증을 MAO가 대신 제공하지 말고 BYOK/사용자 로컬 로그인에 한정한다.; MAO가 clone한 저장소(적대적 입력)에서 -p를 돌리면 그 저장소의 훅/.mcp.json이 실행되므로 --bare 또는 격리가 필요하다.; result.total_cost_usd와 permission_denials를 큐 UI로 올리면 '비용 추적 없음' 약점이 바로 해소된다.

### Claude Code 샌드박싱 (sandbox-runtime) — OS 샌드박스 [verified]
- URL: https://code.claude.com/docs/en/sandboxing
- 무엇: macOS Seatbelt, Linux/WSL2 bubblewrap(+socat) 기반의 오픈소스 @anthropic-ai/sandbox-runtime. 기본값은 꺼짐.
- 견인력: 확인 불가
- 특징: 쓰기는 작업 디렉터리와 임시 디렉터리로 제한되지만 읽기는 기본적으로 ~/.ssh, ~/.aws까지 열려 있어 denyRead 설정이 필요; 네트워크는 호스트 프록시의 allowedDomains/deniedDomains로 제어. 기본 도메인 목록은 비어 있음; 보호 경로(.git/hooks, .mcp.json, 셸 rc, ~/.claude)는 작업 디렉터리 안에서도 쓰기 거부; 네이티브 Windows는 미지원(명령이 샌드박스 없이 실행). WSL2만 가능; --dangerously-skip-permissions는 프롬프트와 권한 검사를 끄지만 OS 샌드박스는 계속 적용된다. 단 bypassPermissions에서는 샌드박스 밖 재시도가 무프롬프트로 실행되고 allowlist 밖 호스트도 허용되므로 strictAllowlist와 allowUnsandboxedCommands:false가 필요; 샌드박스 범위는 셸 명령뿐이다. Read/Edit/Write 도구, WebFetch, MCP 서버, 훅은 샌드박스 밖; tlsTerminate(실험)로 프록시가 자리표시자를 실제 자격증명으로 치환할 수 있다
- MAO 시사점: MAO의 '권한 우회'는 샌드박스를 켜지 않은 채 쓰고 있어 보호막이 전혀 없는 상태다. 샌드박스를 켜고 strictAllowlist를 설정하는 것이 가장 싼 1차 방어다.; Windows는 네이티브 샌드박스가 없으므로 WSL2 또는 컨테이너 경로가 필요하다.; 프록시 기반 자격증명 치환은 '토큰을 에이전트에 보여주지 않는' 설계의 참고 모델이다.

### OpenAI Codex CLI / SDK / app-server — 에이전트 CLI/SDK [verified]
- URL: https://learn.chatgpt.com/docs/non-interactive-mode
- 무엇: codex exec 비대화형 모드, TS/Python SDK, app-server(JSON-RPC). 구 URL developers.openai.com은 learn.chatgpt.com으로 308 리다이렉트된다.
- 견인력: 확인 불가
- 특징: --json은 JSONL 이벤트(thread.started, turn.started, item.*, turn.completed, turn.failed, error)를 낸다. -o로 마지막 메시지 파일 저장, --output-schema로 JSON Schema 강제; 샌드박스 기본은 read-only. --sandbox workspace-write, danger-full-access. --full-auto는 더 이상 지원하지 않음; codex exec resume --last 또는 <SESSION_ID>, --ephemeral, git 저장소 필수(--skip-git-repo-check); CI에서 CODEX_API_KEY는 job 전체가 아니라 해당 호출에만 설정할 것을 권고. ChatGPT auth.json은 공개 저장소에 비권장; OS 샌드박스: macOS Seatbelt, Linux bwrap+seccomp, Windows는 MXC(elevated/unelevated는 레거시 폴백), WSL1 지원 종료; workspace-write에서도 .git, .agents, .codex, .aws는 읽기 전용 보호; 네트워크는 기본 꺼짐. network_proxy로 allowlist 우선 도메인 규칙 적용; danger-full-access(--yolo)는 컨테이너가 보안 경계일 때만 쓰라고 문서화. 악성 프로젝트는 컨테이너 안의 Codex 자격증명에 접근 가능; SDK/app-server: Python SDK는 JSON-RPC로 로컬 app-server 제어. codex mcp-server는 제거되어 app-server로 이전 필요. 스레드 resume/fork 지원. 문서 예시 모델명은 gpt-6.1-sol이며 기본 모델명은 문서에 명시되지 않음
- MAO 시사점: 'codex -s workspace-write'는 이미 올바른 최소 권한 방향이다. 그러나 stdout만 버퍼링하고 --json과 --output-schema를 쓰지 않는다.; 같은 경로의 .git 보호는 MAO의 'git add -A + push --force' 흐름과 충돌 가능하므로 커밋/푸시는 샌드박스 밖 MAO 코어가 수행하도록 분리해야 한다.; 환경변수 범위는 최소화한다. 자식 프로세스에 token을 전달하지 않는다.; 확인하지 못한 점: reasoning effort를 설정하는 정확한 플래그와 종료코드 표.

### Gemini CLI (헤드리스) — 에이전트 CLI [partially-verified]
- URL: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- 무엇: Google의 오픈소스 CLI. -p 또는 non-TTY에서 헤드리스로 동작.
- 견인력: 확인 불가
- 특징: --output-format json은 {response, stats, error}를 반환; stream-json은 init/message/tool_use/tool_result/error/result 이벤트의 JSONL이며 result에 모델별 토큰 통계 포함; 종료코드: 0 성공, 1 일반/API 오류, 42 입력 오류, 53 턴 제한 초과; --yolo 존재 여부와 모델·승인 모드 플래그는 이 페이지에 없고 s1ngularity 보도에서만 확인; GHSA-wpqr-6v78-jr5g(2026-04-24): CVSS 10 RCE, 0.39.1 미만과 run-gemini-cli 0.1.22 미만이 영향(2차 보도 기반)
- MAO 시사점: 종료코드가 의미를 갖는 유일한 CLI이므로 53을 '재시도 금지, 한도 도달'로 분류하는 식의 CLI별 종료코드 매핑이 필요하다.; Antigravity CLI 정보는 이번 조사에서 확인하지 못했다.

### GitHub Copilot CLI — 에이전트 CLI [partially-verified]
- URL: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- 무엇: copilot CLI. -p 프로그램 모드, --output-format json(JSONL), --acp 서버(공개 프리뷰).
- 견인력: 확인 불가
- 특징: -p는 프로그램 실행 후 종료. 프로그램 사용 시 --allow-all-tools 필요, 세분화는 --allow-tool=Kind(arg); --allow-all/--yolo는 --allow-all-tools --allow-all-paths --allow-all-urls와 동일; --acp는 기본 stdio, --port로 TCP. --effort를 시작 시 지정 가능(검색 요약 기반)
- MAO 시사점: --allow-tool 패턴으로 도구 단위 허용이 가능하다. 'all or nothing'보다 세분화된 허용 목록 모델이 존재한다.; 플래그 이름은 copilot --help로 재확인해야 한다(검색 스니펫 기반).

### Cursor CLI (cursor-agent) — 에이전트 CLI [partially-verified]
- URL: https://cursor.com/docs/cli/headless
- 무엇: cursor-agent -p 프린트 모드, text|json|stream-json 출력.
- 견인력: 확인 불가
- 특징: --force/--yolo 없으면 파일 변경을 제안만 한다; stream-json 무출력과 -p 무한 대기 보고가 포럼에 있음; Cursor 포럼에 '잠금형 헤드리스 모드(파일 도구만, 훅/MCP/플러그인 없음)' 기능 요청이 있다는 점은 현재 헤드리스가 훅/MCP를 로드한다는 방증
- MAO 시사점: 스트림 무출력/행(hang) 사례가 있으므로 '출력 없음 N초' 워치독이 필요하다(MAO는 15분 SIGKILL 뿐).; 공식 문서 본문은 열람하지 못했고 검색 스니펫 기반이다.

### Agent Client Protocol (ACP) — 프로토콜 [partially-verified]
- URL: https://agentclientprotocol.com/protocol/overview
- 무엇: Zed가 만든 JSON-RPC 2.0 기반 에디터(클라이언트)-에이전트 프로토콜. 에이전트는 보통 클라이언트의 서브프로세스로 실행된다.
- 견인력: ACP Registry 2026-01-28 베타(Zed+JetBrains). 등록 에이전트에 Claude Code, Codex CLI, Copilot CLI, OpenCode, Gemini CLI 포함. '25개 이상/30개 이상' 지원이라는 수치는 2차 출처 간 불일치
- 특징: initialize 후 session/new, session/load(loadSession 능력 시), session/prompt(정지 사유로 종료), session/cancel, session/update(메시지·도구호출·계획 스트림); 클라이언트 메서드: session/request_permission, fs/read_text_file·write_text_file, terminal/*, elicitation/create; Claude Code는 Anthropic 자체 지원이 아니라 Zed 측 어댑터를 통한 브리지(2차 보도); Microsoft Intelligent Terminal 0.1이 ACP 에이전트를 자동 감지(2차 출처, 실험)
- MAO 시사점: ACP는 'MAO가 클라이언트가 되어 다수 CLI를 하나의 구조화된 인터페이스로 구동'하게 해 주며, 권한 요청을 MAO의 승인 계층으로 가로챌 수 있다.; MAO 자체를 에이전트로 노출하는 것은 지금 필요 없다.; ACP 문서 페이지는 stdio, MCP 서버 전달, 성숙도를 명시하지 않았으므로 스키마 직접 확인이 필요하다.

### Model Context Protocol (MCP) 2026-07-28 사양 — 프로토콜 [partially-verified]
- URL: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- 무엇: 에이전트-도구/데이터 프로토콜. 2025-12 Linux Foundation 산하 Agentic AI Foundation(AAIF)에 기증됨.
- 견인력: LF 발표: MCP 서버 1만 개 이상 공개(AAIF 관련 보도)
- 특징: 상태 비저장 코어: initialize 핸드셰이크와 프로토콜 세션 제거, server/discover 추가; Roots, Sampling, Logging 폐기 예정. 12개월 이상 폐기 유예 정책; 인증은 선택 사항이며 iss 검증(SEP-2468)과 Client ID Metadata Documents 강화. 기업 관리형 인증 확장은 2026-06 안정화; AAIF 창립 프로젝트: MCP, goose, AGENTS.md (2025-12-09)
- MAO 시사점: MAO가 MCP 서버를 노출하면 '이슈/PR/큐 조회'를 다른 에이전트에 제공할 수 있다. 그러나 이는 에이전트가 읽는 새 신뢰 경계이자 주입 경로가 된다.; MAO가 에이전트에 GitHub MCP를 붙이는 경우의 위험은 Invariant의 toxic agent flow 사례가 보여 준다.

### A2A (Agent2Agent) 프로토콜 — 프로토콜 [partially-verified]
- URL: https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- 무엇: 에이전트 간 통신 프로토콜. Linux Foundation 호스팅.
- 견인력: LF 보도자료(2026-04-09): 150개 이상 조직이 지지. 프로덕션 배포 수와는 다름
- 특징: v1.0 안정 사양(2차 출처는 2026-03-12로 표기, LF는 날짜 미명시)
- MAO 시사점: 코딩 CLI 통합 수단으로는 현재 영향이 낮다. MAO에는 후순위.

### Comment and Control (CSA 연구노트) — 보안 사건 [partially-verified]
- URL: https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/
- 무엇: PR 제목, 이슈 본문, 코멘트로 GitHub Actions의 Claude Code Security Review, Gemini CLI Action, Copilot Agent를 탈취해 ANTHROPIC_API_KEY·GITHUB_TOKEN 등을 GitHub 자체 API(코멘트)로 유출한 공격.
- 견인력: 공개: 2026-04-15, CSA 노트 2026-04-17. 벤더 보상금 수준 보고(Anthropic $100, Google $1,337, Microsoft $500), CVE·공개 권고 없음(해당 노트 기준)
- 특징: 유출 경로가 GitHub 엔드포인트라 외부 egress 통제를 우회한다; Copilot 변형은 HTML 주석에 페이로드를 숨겼고 출력 인코딩으로 런타임 방어를 회피; 권고: 작업 흐름 권한 축소, 불필요한 키 제거, SHA 고정, 이벤트 본문의 HTML 주석 제거, 외부 기여자 대상 메인테이너 승인 게이트, 게시 전 출력 비밀 스캔
- MAO 시사점: MAO의 pr 단계는 에이전트에 clone 토큰이 있는 상태로 이슈 텍스트를 읽고, 그 결과를 이슈/PR 코멘트로 올린다. 같은 유출 경로가 그대로 성립한다.; 확인 한계: 페치 요약에 'HackerO...' 같은 깨진 문자열이 있어 보상 경로 세부는 신뢰하지 않는다. 핵심 사실(대상 3종, 날짜, 메커니즘)만 사용했다.

### GitLost (Noma Labs) — 보안 사건 [partially-verified]
- URL: https://siliconangle.com/2026/07/07/gitlost-vulnerability-let-githubs-ai-workflows-leak-private-repositories/
- 무엇: GitHub Agentic Workflows에 대한 간접 프롬프트 주입. 공개 이슈 한 건으로 비공개 저장소 README를 공개 코멘트로 유출.
- 견인력: 2026-07-06~07 공개. 여러 매체 보도
- 특징: 공격자는 인증 불필요. 사내 요청으로 위장한 이슈 본문; 'additionally' 한 단어로 가드레일 우회 보고; MCP 토큰이 읽기 전용이어도 유출됐다는 보도: 읽기 권한만으로 유출이 성립(2차 보도)
- MAO 시사점: '리뷰 에이전트가 읽기만 한다'는 가정이 안전을 보장하지 않는다. 비공개 데이터 접근과 공개 쓰기 채널이 동시에 있으면 위험하다.; MAO 이슈의 공개 코멘트 채널에는 출력 필터가 필요하다.

### s1ngularity (Nx npm 공급망 공격, 2025-08) — 보안 사건 [partially-verified]
- URL: https://socket.dev/blog/nx-packages-compromised
- 무엇: 악성 Nx 패키지가 설치된 AI CLI(Claude Code, Gemini CLI, Amazon Q)를 권한 우회 플래그로 호출해 개발자 시스템의 지갑·비밀을 수색.
- 견인력: GitGuardian 보고: 1,079개 시스템에서 자격증명 2,349건. 약 5시간 20분 노출(검색 요약)
- 특징: --dangerously-skip-permissions, --yolo, --trust-all-tools 사용 보고; gh가 인증되어 있으면 피해자 계정에 s1ngularity-repository 저장소를 만들어 업로드
- MAO 시사점: 공격자가 쓰는 바로 그 플래그를 MAO가 정상 경로로 쓴다. 이 플래그와 로컬 gh 로그인이 공존하면 악성 의존성이 에이전트를 도구로 삼는다.; MAO가 clone한 저장소에서 npm install이나 테스트를 에이전트가 실행하면 같은 경로가 열린다.

### 코딩 에이전트 프로젝트 설정 RCE 계열 (Gemini CLI GHSA, Cursor CVE-2026-26268, Cymulate CVE-2026-35603) — 보안 사건/CVE [partially-verified]
- URL: https://cymulate.com/blog/cve-2026-35603-ai-coding-tools-privilege-escalation/
- 무엇: 저장소/머신 설정 파일(훅, MCP, notify)을 통한 코드 실행 취약점 군.
- 견인력: Cymulate: CVE-2026-35603은 Windows의 ProgramData 설정을 읽는 4개 도구(Claude Code, Cursor, Codex CLI, Gemini CLI). Anthropic만 수정 확인
- 특징: Gemini CLI GHSA-wpqr-6v78-jr5g(2026-04-24, CVSS 10, 2차 보도); Cursor CVE-2026-26268 bare-git RCE(2차 보도); Claude Code CVE-2025-59536, CVE-2026-21852 및 Codex CVE-2025-61260은 2차 보도 기반으로 직접 확인하지 못함; 공통 패턴: 저장소 설정과 훅이 코드 실행 전달체
- MAO 시사점: MAO가 사용자 홈이나 작업 공간에 에이전트를 돌릴 때 에이전트 버전을 고정·점검해야 한다.; 적대적 저장소를 열 때 에이전트 설정 로딩을 끄는 --bare류 옵션을 사용한다.

### Invariant Labs GitHub MCP 'toxic agent flow' + lethal trifecta — 보안 연구 [partially-verified]
- URL: https://invariantlabs.ai/blog/mcp-github-vulnerability
- 무엇: 공개 저장소 악성 이슈로 에이전트가 사용자의 비공개 저장소 데이터를 공개 PR로 유출하게 만든 2025-05 시연. Simon Willison이 '치명적 삼중주'(비공개 데이터, 비신뢰 입력, 유출 능력)로 명명.
- 견인력: 2025-05(검색 결과 기반)
- 특징: MCP 서버 결함이 아니라 프롬프트 주입에 의존한다고 Invariant가 강조; 완화책: push 권한이 있는 사용자의 이슈·PR·코멘트만 에이전트에 노출
- MAO 시사점: 'push 권한 보유자의 글만 읽힌다'는 규칙이 MAO의 author gating 기준과 정확히 일치한다.

### OWASP Top 10 for Agentic Applications (ASI01~ASI10) — 가이드라인 [recalled]
- URL: https://genai.owasp.org/
- 무엇: 자율/반자율 에이전트 위험 10종. 2025-12-09 공개(2026 에디션 표기). 별도로 LLM Top 10 2026이 2026-08-03 공개라는 보도가 있다.
- 견인력: 100명 이상 전문가 참여(2차 보도)
- 특징: 공식 genai.owasp.org 페이지를 직접 열지 못했고 검색 결과로만 확인
- MAO 시사점: 통제 항목 표의 분류 기준으로 인용할 수 있으나 항목별 세부는 직접 확인이 필요하다.

### 컨테이너/클라우드 샌드박스 계층 (E2B, Daytona, Modal, Docker Sandboxes) — 샌드박스 [partially-verified]
- URL: https://fly.io/learn/agent-sandbox-providers/
- 무엇: E2B와 Vercel Sandbox는 Firecracker microVM, Modal은 gVisor, Daytona는 기본 Docker 컨테이너. Docker Sandboxes는 에이전트별 microVM(sbx CLI).
- 견인력: 벤더 비교 블로그 중심, 수치는 미검증
- 특징: 컨테이너는 호스트 커널을 공유하므로 탈출 시 호스트 전체가 노출; 로컬 우선 데스크톱 도구에서의 macOS/Linux/Windows 지원 비교는 확인하지 못함
- MAO 시사점: MAO는 로컬 우선이므로 클라우드 샌드박스는 선택적 백엔드로 두고 기본값은 로컬 OS 샌드박스+컨테이너로 한다.

### GitHub App 설치 토큰 및 Electron safeStorage — 자격증명 통제 [verified]
- URL: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- 무엇: 설치 토큰은 1시간 후 만료되며 repositories(최대 500)와 permissions 본문으로 범위를 좁혀 발급 가능. safeStorage는 macOS Keychain, Windows DPAPI, Linux 시크릿 저장소(없으면 basic_text로 사실상 평문).
- 견인력: 공식 문서
- 특징: Windows DPAPI는 같은 사용자 세션의 다른 앱이 복호화 가능; 동기 API(isEncryptionAvailable, encryptString, decryptString)는 Electron 46에서 제거 예정, 비동기 API 사용; macOS는 미서명 시 업데이트 후 키체인 재프롬프트 가능
- MAO 시사점: MAO가 평문 JSON에 저장하는 토큰을 safeStorage로 옮기되 Linux basic_text는 거부하고 경고해야 한다.; 작업당 단일 저장소·최소 권한 1시간 토큰이 'clone URL에 장기 토큰 삽입'의 대안이다.

## 트렌드

- **이슈·PR·코멘트 텍스트를 통한 CI 에이전트 탈취가 2026년 반복 패턴이 되었다** — 근거: Comment and Control(2026-04, Claude/Gemini/Copilot), GitLost(2026-07), Gemini CLI CVSS 10 GHSA(2026-04). CSA는 한 해에 여러 제품에서 같은 패턴을 문서화했다고 보고. https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/ → 시사점: 자동 큐잉된 공개 이슈를 도구 권한이 열린 에이전트에 넣는 MAO는 이 패턴의 정중앙에 있다. 신뢰 게이팅이 모든 기능에 우선한다.
- **유출 경로가 GitHub 자체 채널(코멘트, PR)이라 egress 통제만으로 막을 수 없다** — 근거: Comment and Control은 GitHub API로 비밀을 게시. GitLost는 공개 코멘트로 비공개 README 게시. 출처는 위와 siliconangle 기사. → 시사점: 네트워크 allowlist에 더해 에이전트 출력(코멘트·PR 본문·커밋)의 비밀·민감 데이터 스캔과 게시 전 차단이 필요하다.
- **'권한 우회' 플래그는 방어자만의 도구가 아니라 공격자의 표준 도구가 되었다** — 근거: s1ngularity가 --dangerously-skip-permissions, --yolo, --trust-all-tools로 설치된 CLI를 호출. https://socket.dev/blog/nx-packages-compromised → 시사점: MAO 프로세스·자식 프로세스의 인증 정보 범위를 줄이고 OS 샌드박스를 의무화한다.
- **벤더는 '프롬프트 끄기'와 '샌드박스'를 분리해 설계하고 문서화한다** — 근거: Claude Code: skip-permissions 후에도 OS 샌드박스는 유지되나 bypass에서는 allowlist 밖 호스트를 허용. Codex: 기본 read-only·네트워크 off, danger-full-access는 컨테이너가 경계일 때만 권고. → 시사점: MAO는 CLI별 '샌드박스 켜진 권한 모드'를 기본으로 하고 완전 우회는 컨테이너/VM 안에서만 허용하는 정책 계층을 갖춰야 한다.
- **헤드리스 구조화 출력과 SDK/app-server 경로가 표준화됐다** — 근거: Claude stream-json+system/init+api_retry, Codex --json JSONL+app-server, Gemini stream-json+종료코드, Copilot json JSONL+--acp. 각 공식 문서. → 시사점: stdout 버퍼링 어댑터를 JSONL 파서로 교체하면 진행률, 비용, 속도 제한 신호를 얻는다.
- **ACP가 에이전트-클라이언트 연결의 사실상 공통 어댑터로 부상했다** — 근거: ACP Registry 2026-01-28(Zed, JetBrains), 등록 에이전트 5종 이상, Copilot CLI --acp. https://zed.dev/blog/acp-registry → 시사점: CLI별 어댑터 N개 대신 ACP 클라이언트 1개 + 예외 어댑터 구조가 가능하나, 권한·샌드박스 의미는 에이전트별로 달라 MAO의 정책 계층이 여전히 필요하다.
- **프로토콜 거버넌스가 Linux Foundation으로 모였다** — 근거: AAIF(2025-12-09): MCP, goose, AGENTS.md. A2A도 LF 호스팅. MCP 2026-07-28 사양은 상태 비저장화. → 시사점: AGENTS.md는 입력 신뢰 경계로 취급한다(저장소 기여자가 쓸 수 있는 에이전트 지시문). MCP는 사양 변동이 크므로 의존을 최소화한다.
- **에이전트 설정 파일(훅, MCP, notify)이 코드 실행 벡터가 되었다** — 근거: Cymulate CVE-2026-35603(4개 도구, ProgramData), Claude -p가 신뢰 확인 없이 저장소 훅/.mcp.json 실행(공식 문서), Cursor 포럼의 잠금 모드 요청. → 시사점: 적대적 저장소에서 에이전트를 돌릴 때 설정 자동 로딩을 끄는 플래그(--bare 등)와 격리를 병행한다.

## 이용자 니즈

- [오픈소스 메인테이너(공개 저장소 이슈 자동 처리 희망)] 외부인이 올린 이슈가 에이전트를 조종하지 못하게 하면서 자동화 이득을 얻고 싶다 — 근거: Comment and Control, GitLost, Invariant. 모두 공개 이슈 텍스트가 진입점 — MAO 적합도: 현재 부적합. author_association/라벨 게이트, 읽기 전용 리뷰 단계, 출력 스캔이 있어야 적합해진다.
- [개인 개발자(로컬에서 여러 AI CLI 사용)] 내 SSH 키·클라우드 자격증명·로그인된 gh가 에이전트에 노출되지 않기를 원한다 — 근거: s1ngularity(로컬 CLI + gh 악용), Claude 샌드박스 문서(읽기가 ~/.ssh까지 기본 개방) — MAO 적합도: 샌드박스·denyRead·환경변수 정화가 있으면 로컬 우선 도구로서 강점이 된다.
- [소규모 팀 리드] 비용, 진행률, 실패 사유(속도 제한 vs 인증 vs 모델 없음)를 보고 싶다 — 근거: Claude total_cost_usd와 api_retry.error 분류, Gemini 종료코드 53, Codex turn.failed — MAO 적합도: 구조화 출력 파서만으로 달성 가능. MAO의 '비용 추적 없음' 약점이 바로 해결된다.
- [보안 담당자/컴플라이언스] 감사 로그, 승인 계층, 토큰 수명과 범위 증빙 — 근거: GitHub App 설치 토큰 1시간·저장소/권한 범위 지정, OWASP 에이전트 Top 10(2차) — MAO 적합도: 단일 평문 JSON 상태는 부적합. 감사 가능한 로그와 단명 토큰이 필요하다.
- [Windows 사용자] 에이전트 격리가 되는 실행 경로 — 근거: Claude Code 네이티브 Windows 샌드박스 미지원, Codex는 MXC/WSL2 — MAO 적합도: Windows에서는 WSL2 또는 컨테이너를 필수로 안내하고, 불가하면 완전 우회 모드를 막아야 한다.

## 권고

- (P0/now) **자동 큐잉 신뢰 게이트: 작성자 권한과 메인테이너 라벨 없이는 공개 저장소 이슈를 큐잉하지 않는다** — 가장 큰 노출 지점. 기본값을 '저장소 push 권한 보유자(OWNER/MEMBER/COLLABORATOR)가 쓴 이슈, 또는 메인테이너가 라벨을 단 이슈만'으로 하고, 본문의 HTML 주석·숨은 텍스트를 제거한 뒤 프롬프트에 넣는다. 응답하는 사건: Comment and Control(2026-04), GitLost(2026-07), Invariant(2025-05). 공개 사용 전 필수. [출처: Comment and Control 권고(메인테이너 승인 게이트, HTML 주석 제거), Invariant 완화책(push 권한자 콘텐츠만)]
- (P0/now) **에이전트를 OS 샌드박스 안에서만 실행: 권한 우회는 샌드박스·네트워크 allowlist가 켜진 경우에만 허용** — Claude는 skip-permissions 뒤에도 OS 샌드박스를 유지하지만 기본은 꺼짐이며, bypass 모드는 allowlist 밖 호스트를 허용하므로 strictAllowlist와 allowUnsandboxedCommands:false가 필요하다. Codex는 workspace-write+네트워크 off가 기본. 샌드박스를 확인할 수 없으면 완전 우회 모드를 거부한다. 응답하는 사건: s1ngularity, 설정 파일 RCE 군. [출처: Claude Code 샌드박싱 문서, Codex 승인·보안 문서]
- (P0/now) **토큰 분리: 에이전트에는 작업당 단일 저장소·최소 권한 GitHub App 설치 토큰(1시간)만 주고, push·머지·코멘트 게시는 MAO 코어가 수행** — clone URL에 장기 토큰을 삽입하는 현재 방식은 .git/config에 비밀이 남는다. 설치 토큰은 repositories/permissions로 범위 지정이 가능하고 1시간 만료다. 에이전트 프로세스 환경변수에서 GITHUB_TOKEN·API 키·로컬 gh 인증을 제거한다. 응답하는 사건: Comment and Control(GITHUB_TOKEN 유출), s1ngularity(gh 악용). [출처: GitHub 설치 토큰 문서, Codex의 호출 단위 CODEX_API_KEY 권고, Claude 프록시 자격증명 치환]
- (P0/now) **에이전트 출력 게시 전 비밀·민감 데이터 스캔과 게시 채널 통제** — 유출 경로가 GitHub 코멘트·PR 본문 자체라 egress 통제로는 못 막는다. 코멘트·PR 설명·커밋 diff를 게시 전에 gitleaks 류로 검사하고, 비공개 저장소 데이터가 공개 저장소 채널로 가는 경우를 차단한다. 응답하는 사건: Comment and Control, GitLost. [출처: CSA 권고(게시 전 출력 비밀 스캔), GitLost 완화책]
- (P1/next) **리뷰를 구속력 있게: 리뷰어에 diff를 전달하고 구조화된 판정(JSON schema)을 받아 'reject'면 머지를 막고, 사람 승인 계층을 둔다** — 현재 리뷰는 코멘트일 뿐이고 CI 녹색/없음이면 머지된다. Codex --output-schema와 Claude --json-schema로 판정을 구조화한다. 보호 경로(.github/workflows, 에이전트 설정)를 변경하는 PR은 항상 사람 승인으로 올린다. 자동 머지는 점진 도입. [출처: Codex --output-schema, Claude --json-schema, Claude 보호 경로 개념]
- (P1/next) **에이전트별 구조화 어댑터 도입: Claude stream-json, Codex --json/app-server, Gemini stream-json, Copilot JSONL** — 모든 CLI에 --model/--effort를 붙이는 방식은 취약하다. CLI별 능력 표(플래그 지원, 출력 모드, 종료코드, 재개)를 두고 비용, 진행, 속도 제한(api_retry.error, 종료코드 53 등)을 큐에 노출한다. 세션 재개로 재시도 비용도 줄인다. [출처: Claude headless 문서, Codex 비대화형 문서, Gemini headless 문서]
- (P1/next) **API 어댑터 현대화: 기본 모델 claude-3-5-sonnet-20241022 / gpt-4o 제거, 모델 목록 API로 선택** — Anthropic 현행 모델표에 해당 ID가 보이지 않고 현행은 claude-sonnet-5-5 등이다(퇴역 여부는 deprecations 페이지를 열지 못해 미확인). 모델 ID를 하드코딩하지 말고 Models API의 capabilities를 조회한다. thinking·effort 의미가 모델별로 달라 일괄 --effort 부착은 위험하다. [출처: Anthropic Models overview(2026-11-12 조회)]
- (P2/later) **ACP 클라이언트를 보편 어댑터로 추가하고 권한 요청(session/request_permission)을 MAO 승인 계층에 연결** — 등록 에이전트가 늘어도 어댑터를 새로 쓰지 않아도 된다. 다만 샌드박스 의미는 에이전트별로 다르므로 정책은 MAO가 소유한다. MCP 서버 노출은 새 주입 경계를 만들므로 지금은 하지 않고, 필요하면 읽기 전용·로컬 한정으로 후순위 검토. [출처: ACP 개요 문서, ACP Registry 발표, Copilot --acp]
- (P2/next) **저장소 자격증명 저장을 safeStorage/OS 키체인으로 이전하고 Electron 하드닝 유지** — 평문 JSON 토큰은 s1ngularity 유형 악성코드의 수확 대상이다. 단 Linux basic_text는 사실상 평문이므로 감지해 거부/경고하고, Windows DPAPI는 같은 세션의 다른 앱을 막지 못한다. 비동기 API로 구현(동기 API는 Electron 46 제거 예정). 서명되지 않은 macOS 빌드는 키체인 재프롬프트가 생기므로 서명과 함께 진행. [출처: Electron safeStorage 문서]
- (P3/later) **감사 로그와 장시간 실행 안전장치: 불변 이벤트 로그, 무출력 워치독, 예산 상한(--max-budget-usd 등)** — Cursor -p 행 사례가 보고돼 있고 MAO의 15분 SIGKILL만으로는 느리다. 모든 에이전트 호출의 모델, 프롬프트 해시, 도구 호출, 종료코드를 추가 전용 로그로 남기면 사고 후 재구성이 가능하다. JSON 단일 파일 상태와 분리. [출처: Claude --max-budget-usd, Cursor 포럼 보고, 보안 담당자 요구]

## 질문별 답

1. (1) 낡았거나 취약하거나 빠진 것. 낡음: API 어댑터의 기본 모델 claude-3-5-sonnet-20241022 / gpt-4o. 현행 Anthropic 표에는 claude-sonnet-5-5, claude-opus-5-5, claude-fable-5-2, claude-haiku-5-5가 있고 3.5 sonnet은 목록에 없다(퇴역 상태는 deprecations 페이지 미열람으로 미확인). Codex 문서의 예시는 gpt-6.1-sol이다. 취약함: 모든 CLI에 --model/--effort를 붙이는 방식. 이번에 확인한 문서 범위에서 Claude는 /effort 슬래시 명령, Copilot은 --effort가 확인됐지만 Codex·Gemini의 effort 플래그는 확인하지 못했다. 문서화되지 않은 플래그는 CLI가 오류를 내거나 무시한다. 15분 SIGKILL만 있는 타임아웃은 Cursor -p 행 사례에 비해 느리다. stdin 프롬프트 방식은 --append-system-prompt처럼 시스템 지시와 사용자 입력을 분리하는 수단을 쓰지 않는다. 빠짐: (a) 구조화 출력(claude stream-json, codex --json, gemini stream-json, copilot json) 파싱 전무로 비용·진행·속도 제한 신호가 없음. (b) 종료코드 해석 없음(Gemini 42/53, Claude 143 등). (c) 세션 재개 미사용. (d) 샌드박스 미사용: 'claude --dangerously-skip-permissions'는 프롬프트와 권한 검사를 끌 뿐이며 Claude의 샌드박스는 기본 꺼짐이다. (e) 적대적 저장소에서 -p가 저장소 훅/.mcp.json을 신뢰 확인 없이 실행하는 문제(Claude 문서)에 대한 --bare 같은 완화 없음. (f) 리뷰에 diff 미전달, 구속력 없음(MAO 자체 약점). 확인하지 못한 것: Aider, Goose, Amp, OpenCode의 세부 플래그(1차 출처 미확보).
2. (2) 목표 어댑터 구조: 3계층을 권고한다. 1) 정책 계층(MAO 코어 소유): 샌드박스 요구 수준, 네트워크 allowlist, 토큰 발급, 승인 계층, 출력 스캔. 에이전트가 무엇을 하든 정책은 MAO가 결정한다. 2) 에이전트별 구조화 어댑터: claude(-p stream-json 또는 Agent SDK), codex(exec --json 또는 SDK/app-server), gemini(stream-json), copilot(JSONL). 각 어댑터는 '능력 표'(지원 플래그, effort 지원, 재개, 종료코드 매핑, 비용 필드)를 선언한다. 3) ACP 클라이언트: Registry에 있는 다른 에이전트(OpenCode 등)와 Copilot --acp를 위한 보편 경로이며, session/request_permission을 MAO 승인으로 연결한다. SDK 대 CLI: Claude Agent SDK는 Claude Code 바이너리를 구동하는 라이브러리이므로 콜백(canUseTool)과 훅으로 권한을 가로챌 수 있어 CLI보다 통제가 세밀하다. 단 SDK 약관상 claude.ai 로그인을 제3자가 제공하는 것은 금지(API 키 사용). Codex는 codex mcp-server가 제거되어 app-server가 공식 경로다. PTY 스크래핑은 구조화 출력이 있는 CLI에는 불필요하다. MCP 서버 노출 여부: 지금은 권고하지 않는다. MAO가 MCP 서버가 되면 다른 에이전트가 MAO의 큐·이슈 데이터를 읽는 새 비신뢰 입력 경계가 생기고, MCP 2026-07-28 사양은 상태 비저장화로 변동이 크다. 필요해지면 읽기 전용·로컬 한정으로 시작한다. 반대로 에이전트에 GitHub MCP를 붙이는 것은 Invariant 사례가 보여 주듯 권한 범위를 먼저 줄인 뒤에만 한다.
3. (3) 공개 저장소 이슈를 자동 큐잉해 권한 우회 에이전트로 처리하고 AI 리뷰 후 자동 머지하는 도구의 통제 기준선. [공개 사용 전 필수] M1 작성자 신뢰 게이트(push 권한자 또는 메인테이너 라벨만) + 이슈 본문의 HTML 주석 제거: Comment and Control, GitLost, Invariant. M2 OS 샌드박스 필수와 네트워크 allowlist(권한 우회는 샌드박스 확인 후에만): s1ngularity, 설정 RCE 군(Gemini CVSS 10, Cymulate). M3 에이전트 프로세스에서 장기 토큰·로컬 gh 인증·API 키 제거, 작업당 단일 저장소·1시간 설치 토큰, 푸시·코멘트·머지는 코어가 수행: Comment and Control(GITHUB_TOKEN/API 키 유출), s1ngularity. M4 게시 전 출력 비밀 스캔과 공개/비공개 채널 분리: Comment and Control, GitLost. M5 자동 머지 중지 또는 사람 승인 기본값(리뷰가 구속력을 갖기 전까지): 현재 리뷰는 코멘트일 뿐이라는 MAO 자체 약점. M6 기본 거부 정책: 샌드박스가 없는 환경(네이티브 Windows 등)에서는 완전 우회 모드를 비활성화. [다음 단계] N1 보호 경로(.github/workflows, 에이전트 설정, .git/hooks) 변경 PR은 항상 사람 승인: Claude/Codex가 보호 경로를 별도 취급하는 근거. N2 적대적 저장소에서 설정 자동 로딩 차단(--bare) 및 에이전트 버전 고정·점검. N3 감사 로그와 무출력 워치독·예산 상한. N4 리뷰어에 diff 전달 + 구조화 판정으로 머지 차단. N5 시크릿 저장소 이전(safeStorage). [고급] A1 microVM/클라우드 샌드박스 백엔드(E2B 류)와 자격증명 프록시(요청 시점 치환). A2 별도 제공자 리뷰의 적대적 검증(주입 탐지 분류기). A3 egress를 GitHub 엔드포인트 단위로 필터링. 인용한 사건들의 세부(보상금, 날짜 등)는 대부분 2차 보도 기반임을 감안해야 한다.
4. (4) 로컬 우선 데스크톱/CLI용 샌드박스. 단일 기법으로 3개 OS를 덮는 것은 없다. 계층형 권고: 기본은 '에이전트-네이티브 OS 샌드박스를 MAO가 강제하는 정책으로 켜는 것'이다. macOS: Seatbelt(Claude, Codex 모두 사용). Linux: bubblewrap(+seccomp, Codex는 bwrap+seccomp, Claude는 bwrap+socat). Windows: Claude Code는 네이티브 샌드박스를 지원하지 않으며(WSL2만), Codex는 MXC를 제공하고 WSL2에서는 Linux 구현을 쓴다. 따라서 Windows는 'WSL2 또는 컨테이너/VM이 있을 때만 권한 우회 허용'으로 정책화한다. 모든 OS에서 완전 우회(danger-full-access, --yolo)는 컨테이너/microVM이 경계일 때만 허용한다(Codex 문서의 입장). 컨테이너(Docker/devcontainer)는 호스트 커널을 공유하므로 탈출 위험이 있고, microVM(Firecracker 기반 E2B 등, Docker Sandboxes)이 더 강하지만 로컬 OS 지원은 이번에 확인하지 못했다. 클라우드 샌드박스(E2B, Daytona, Modal)는 선택적 원격 백엔드로 둔다. 어떤 경우에도 샌드박스는 셸 명령만 덮는 경우가 있다는 점(Claude의 Read/Edit/WebFetch/MCP는 샌드박스 밖)을 반영해 도구 허용 목록을 병행한다. 네트워크는 호스트 프록시 allowlist(빈 목록에서 시작), 로컬/링크 로컬(169.254.169.254) 차단.
5. (5) 상위 10개 권고(순위). 1 신뢰 게이트(작성자·라벨, HTML 주석 제거). 2 OS 샌드박스 필수 + 권한 우회는 샌드박스 확인 시에만 + 네트워크 allowlist. 3 토큰 분리: 작업당 단일 저장소 설치 토큰(1시간), 에이전트 환경에서 장기 비밀 제거, 쓰기 작업은 코어가 수행. 4 게시 전 출력 비밀 스캔과 공개/비공개 채널 분리. 5 구속력 있는 리뷰: diff 전달 + 구조화 판정 + 보호 경로 사람 승인 + 자동 머지 기본 해제. 6 에이전트별 구조화 어댑터와 능력 표(비용, 진행, 종료코드, 재개). 7 API 어댑터 모델 현대화와 모델 목록 API 사용. 8 ACP 클라이언트 추가(보편 어댑터, 권한 요청 연결). 9 시크릿 저장소를 safeStorage로 이전(Linux basic_text 거부). 10 감사 로그·무출력 워치독·예산 상한. 우선순위는 위험 순서이며, 1~4는 공개 사용 전 필수, 5~7은 다음 단계, 8~10은 이후 단계다.

## 출처

- https://code.claude.com/docs/en/headless — Claude Code -p 헤드리스: 출력 형식, stream-json 이벤트, api_retry 분류, 권한 모드, 재개, 종료코드, --bare, 저장소 훅/.mcp.json 실행 경고
- https://code.claude.com/docs/en/sandboxing — Claude Code 샌드박스: Seatbelt/bubblewrap, 네이티브 Windows 미지원, skip-permissions와 샌드박스 상호작용, 보호 경로, 프록시 allowlist (본문 중 약 11K자는 미열람)
- https://code.claude.com/docs/en/agent-sdk/overview — Claude Agent SDK 기능과 claude.ai 로그인 제3자 제공 금지 조항
- https://learn.chatgpt.com/docs/non-interactive-mode — codex exec --json, --output-schema, 샌드박스 모드, resume, CI 인증 권고
- https://learn.chatgpt.com/docs/agent-approvals-security — Codex 샌드박스 OS별 구현, 보호 경로, 승인 정책, danger-full-access
- https://learn.chatgpt.com/docs/codex-sdk — Codex SDK/app-server, codex mcp-server 제거, 스레드 resume
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md — Gemini CLI 헤드리스, JSON/stream-json, 종료코드 0/1/42/53
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference — Copilot CLI 프로그램 모드 (검색 스니펫 기반, 본문 미열람)
- https://cursor.com/docs/cli/headless — Cursor CLI 헤드리스 (검색 스니펫 기반, 본문 미열람)
- https://platform.claude.com/docs/en/about-claude/models/overview — 현행 Claude 모델 ID와 가격, 3.5 sonnet 미등재
- https://agentclientprotocol.com/protocol/overview — ACP 메서드와 클라이언트 능력
- https://zed.dev/blog/acp-registry — ACP Registry 2026-01-28, 등록 에이전트
- https://modelcontextprotocol.io/specification/2026-07-28/changelog — MCP 2026-07-28 사양 (검색 결과 요약만, 본문 미열람)
- https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year — A2A 150개 이상 조직 (검색 결과 요약)
- https://sdtimes.com/ai/linux-foundation-forms-agentic-ai-foundation-to-be-new-home-for-mcp-goose-and-agents-md/ — AAIF 창립: MCP, goose, AGENTS.md (검색 결과 요약)
- https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/ — Comment and Control (일부 깨진 문자열 포함, 핵심 사실만 사용)
- https://siliconangle.com/2026/07/07/gitlost-vulnerability-let-githubs-ai-workflows-leak-private-repositories/ — GitLost
- https://socket.dev/blog/nx-packages-compromised — s1ngularity (검색 결과 요약, 본문 미열람)
- https://invariantlabs.ai/blog/mcp-github-vulnerability — GitHub MCP toxic agent flow (검색 결과 요약)
- https://cymulate.com/blog/cve-2026-35603-ai-coding-tools-privilege-escalation/ — CVE-2026-35603 ProgramData 설정 취약점
- https://thehackernews.com/2026/04/google-fixes-cvss-10-gemini-cli-ci-rce.html — Gemini CLI CVSS 10 (본문 403, 검색 결과 요약만 사용)
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app — 설치 토큰 1시간, 저장소/권한 범위 지정
- https://www.electronjs.org/docs/latest/api/safe-storage — Electron safeStorage OS별 동작과 basic_text 경고
- https://fly.io/learn/agent-sandbox-providers/ — E2B/Modal/Daytona 격리 계층 비교 (벤더 블로그, 검색 결과 요약)
- https://genai.owasp.org/ — OWASP 에이전트 Top 10 (직접 열지 못함, 검색 결과로만 확인)

## 확인하지 못한 것
예산 약 45회 중 약 30회를 사용했다. 확인하지 못한 것들. (1) Aider, Goose, Amp, OpenCode의 헤드리스 플래그, 출력 모드, 권한 모델은 1차 출처에서 확인하지 못했다(OpenCode 페이지에는 해당 플래그가 없었고 Amp 페이지는 목차뿐이었다). 이 네 가지에 대해 아는 내용은 기억에 의존하므로 본 결과에 사실로 포함하지 않았다. (2) Gemini CLI/Antigravity: Antigravity CLI는 조사하지 못했고, Gemini의 --yolo, 승인 모드, 모델 선택 플래그는 헤드리스 페이지에 없어 s1ngularity 보도로만 확인했다. (3) Copilot CLI와 Cursor CLI는 검색 결과 스니펫 기반이며 공식 본문은 열람하지 못했다. (4) Codex의 reasoning effort 플래그와 종료코드 표, Claude CLI의 --effort 플래그 자체는 확인하지 못했다. (5) MCP 2026-07-28 사양, A2A 1.0 날짜, AAIF, OWASP 에이전트 Top 10은 검색 결과 요약으로만 확인했고 공식 본문은 열람하지 못했다. 레지스트리와 AGENTS.md 거버넌스 세부, Agent Skills 사양은 조사하지 못했다. (6) 보안 사건의 세부(보상금 금액, CVSS 수치, CVE 번호, 영향 버전, 노출 시간, 탈취 건수)는 대부분 2차 보도이며, Comment and Control 페치 요약에는 깨진 문자열이 있어 일부 문장을 사용하지 않았다. Gemini CVSS 10 기사와 Black Hat 2026 기사는 열리지 않았다(403/404). Claude Code CVE-2025-59536, CVE-2026-21852, Codex CVE-2025-61260은 직접 확인하지 못했다. (7) claude-3-5-sonnet-20241022가 현행 모델표에 없다는 것은 확인했지만 정확한 퇴역 일자는 모델 deprecations 페이지를 열지 못해 모른다. (8) 로컬 OS별 microVM 샌드박스(Docker Sandboxes 등)의 지원 범위, 별칭 'Antigravity'의 대응 제품, 프로젝트별 스타 수와 채택 지표는 조사하지 못했다. (9) 이번 작업은 저장소 코드를 읽지 않았으므로 MAO의 현재 구현에 대한 서술은 요청서에 적힌 내용을 그대로 전제했다. (10) 외부 서비스 질의에는 어떤 개인 이름도 넣지 않았다.
