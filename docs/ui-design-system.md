# MAO UI 디자인 시스템 명세 및 후보군 비교 분석 (Issue #108)

본 문서는 MAO 데스크톱 애플리케이션(`electron/` + `src/`)과 헤드리스 CLI(`cli/`)가 공유하는 **선택 가능한 디자인 시스템(Selectable Design System)**의 사전 조사, 동일 화면·동일 샘플 데이터 기반 후보군 비교 분석, 최종 구현 대상 선정 근거, 그리고 의미 기반(Semantic) CSS 토큰 계약을 정의합니다.

---

## 1. 기존 화면 및 토큰 조사

### 1.1 기존 토큰 구조 (`src/index.css`)
기존 렌더러 스타일시트는 `:root`(라이트 모드 기본값)와 `:root[data-theme='dark']`(다크 모드 오버라이드) 두 블록에 단일 시각 언어(웜 스톤 배경 + 버밀리온 포인트)만 정의하고 있었습니다.

| 분류 | 기존 토큰 | Light 값 | Dark 값 | 조사에서 확인된 한계점 |
| --- | --- | --- | --- | --- |
| 배경/표면 | `--color-bg`, `--color-surface` | `#f3f2f2`, `#eae9e9` | `#1a1817`, `#262322` | 3단계 계층(`--color-bg-subtle`)이 정의되지 않아 일부 컴포넌트에서 미정의 변수를 참조함 |
| 텍스트/구분선 | `--color-text`, `--color-divider` | `#201e1d`, `rgb(32 30 29 / 0.4)` | `#f3f2f2`, `rgb(243 242 242 / 0.16)` | 1px 보조 보더용 `--color-border`가 없고, `.text-muted`가 반투명(`rgb(var(--color-text-rgb) / 0.5)`)에 의존해 어두운 표면 위에서 WCAG AA 대비가 흔들릴 수 있음 |
| 브랜드/강조 | `--color-accent`, `--color-accent-2` | `#ec3013`, `#e15b47` | `#ff6a4a`, `#ff8f78` | 브랜드 주조색과 주요 액션 버튼(`.btn-primary`), 선택 상태(`.sidebar-item.active`), 오류(error)·실행 중(running) 상태가 동일한 붉은 계열에 묶여 있음 |
| 배지/태그 | `--color-accent-100` ~ `800`, `--color-neutral-100` / `800` | `#fff2ef` / `#7c1405` | `#3a1c14` / `#ffd3c4` | 오류(`tag-accent`), 일시정지(`tag-warn`), 완료(`tag-neutral`), 진행(`tag-outline`)의 의미 분리가 약함 |
| 타이포그래피 | `--font-heading`, `--font-body` | `'Archivo', system-ui, sans-serif` | 동일 | 프롬프트 및 SHA/로그 표시를 위한 고정폭 폰트 토큰(`--font-mono`)이 분리되어 있지 않음 |
| 형태/모서리 | `--radius-md` | `0px` | `0px` | 직각 모서리 원칙(`0px`)이 유지되고 있으나 일부 인라인 클래스(`rounded`)가 혼재함 |

### 1.2 주요 화면별 컴포넌트 조사 및 개선 지점

1. **`Sidebar` (`src/components/Sidebar.tsx`)**
   - 프로젝트 목록, 저장소 추가 폼, 스토어 복구 경고 카드(`githubRepos`, `workflowTasks`, `persistenceBroken`), 전역 설정 진입 버튼을 포함합니다.
   - **개선 지점**: 활성 프로젝트 행(`.sidebar-item.active`)에 전용 선택/액션 토큰(`--color-action-bg`, `--color-action-text`, `--color-action-border`)을 적용하여 `Crimson Signal`에서는 라이트·다크 모드 모두 붉은색(버건디) 사이드바 바탕 위에 노란색(웜 앰버) 선택 행이 선명히 부각되도록 개선합니다. 또한 스토어 복구/경고 배너가 브랜드 색상과 혼동되지 않도록 의미 기반 경고/오류 스타일과 비색상 기호(`⚠`, `✕`)를 함께 제공합니다.
2. **`KanbanBoard` (`src/components/KanbanBoard.tsx`)**
   - `Open Issues`, `In Progress / PRs`, `Done / Merged` 3개 컬럼과 카드별 워크플로 배지(`workflowBadgeClass`), 실행 중 펄스(`.card-active`), 에이전트 할당 정보, 프롬프트 펼침 영역을 렌더링합니다.
   - **개선 지점**: 붉은색 베이스 디자인(`Crimson Signal`)을 적용할 때 브랜드 붉은색/노란색과 작업 실패(`failed`)·일시정지(`paused`)·진행 중(`running`)·완료(`done`) 배지가 색채와 형태(아이콘 기호 + 보더 스타일) 양쪽에서 즉시 구별되도록 개선합니다.
3. **`WorkflowQueue` (`src/components/WorkflowQueue.tsx`)**
   - 큐에 등록된 작업 카드, 단계별 상태 태그(`statusTagClass`), 에이전트 배지(`AgentBadge`), 실행 이력(`history`) 및 프롬프트 전문(`<pre>`)을 표시합니다.
   - **개선 지점**: 프롬프트와 실행 로그 영역에 `--font-mono` 및 `--color-bg-subtle`을 적용해 장시간 모니터링 시 가독성을 높입니다.
4. **`TaskDetailModal` (`src/components/TaskDetailModal.tsx`)**
   - 이슈/PR 본문, 라벨, 코멘트 목록, 워크플로 큐 등록 컨트롤을 모달로 표시합니다.
   - **개선 지점**: 모달 백드롭(`.modal-backdrop`)과 카드 경계선을 디자인 프리셋의 표면 토큰과 연동합니다.
5. **`GlobalSettings` / `ProjectSettings` / `UpdateBanner`**
   - `GlobalSettings.tsx`에서 정의되지 않은 `--color-border`, `--color-bg-subtle` 참조를 정식 시맨틱 토큰으로 연결하고, **Light / Dark / System 모드 선택**과 직교(orthogonal)하는 **Design System 프리셋 선택기(스와치 미리보기 포함)**를 제공합니다.
   - 모든 대화형 컨트롤(`.btn`, `.input`, `.tab`, `.sidebar-item`, `.design-option`)에 `:focus-visible` 기반 `--color-focus` 포커스 링을 통일하고, `--radius-md: 0px` 직각 기하학 원칙과 오프라인 안전 시스템 폰트 스택을 유지합니다.

---

## 2. 후보군 비교 분석 (동일 화면·동일 샘플 데이터 기준)

### 2.1 외부 오픈소스 디자인 시스템 레퍼런스 검토
새 디자인 토큰 계층을 설계하기 위해 두 가지 오픈소스 디자인 시스템을 검토했습니다.

- **Radix Themes (Token Scale & Semantic Aliasing)**
  - 배경(`bg` / `surface` / `subtle`), 텍스트(`text` / `text-muted`), 경계선(`border` / `divider`), 브랜드 강조(`accent` / `highlight`), 주요 액션·선택(`action-bg` / `action-text` / `action-border`), 상태(`danger` / `warning` / `success`)를 역할별로 분리하는 2계층 시맨틱 토큰 구조를 참고했습니다.
- **Carbon Design System (UI Shell, High-Density Console & Non-Color Status Indicators)**
  - 좌측 고정 사이드바(`UI Shell`)와 우측 작업 영역의 경계 대비, 고밀도 개발자 콘솔 환경에서의 1px 구조선, 그리고 상태 배지에 색상뿐 아니라 형태·기호(`✕`, `⚠`, `●`, `✓`)를 결합하는 규칙을 참고했습니다.
- **외부 런타임 라이브러리 미도입 근거**
  - 외부 UI 컴포넌트 패키지를 추가하면 번들 크기 증가, 런타임 스타일 주입 오버헤드, 기존 직각 모서리(`--radius-md: 0px`) 규칙과의 충돌, 그리고 Testing Library 기반 렌더러 테스트(`src/**/*.test.tsx`)의 DOM 구조 변경이 발생합니다. 따라서 `package.json` 의존성 추가 없이 순수 CSS 커스텀 프로퍼티(`src/index.css`)와 `@layer components` 확장만으로 다중 디자인 시스템을 구현했습니다.

### 2.2 비교 기준 샘플 데이터 및 대상 화면
모든 후보군은 아래의 **동일한 4개 핵심 화면**과 **동일한 샘플 데이터**를 기준으로 평가했습니다.

- **대상 화면 (4종)**: `Sidebar`(프로젝트 탐색 및 상태 경고), `KanbanBoard`(3컬럼 이슈/PR 보드), `WorkflowQueue`(단계별 실행 큐 및 프롬프트 로그), `GlobalSettings`(테마·디자인·AI 프로바이더 설정)
- **공통 샘플 데이터**:
  - 저장소: `acme/widgets` (활성 선택), `acme/cli-tools` (비활성)
  - 작업 A (실행 중): `Issue #42 · Implement token refresh` — 상태 `PR running`, 담당 `Claude · claude-sonnet-4-6 · high effort`, `.card-active` 및 `.live-dot` 활성
  - 작업 B (일시정지): `PR #43 · Fix race condition in poller` — 상태 `Review paused`, 담당 `Codex · gpt-5.4 · medium effort`
  - 작업 C (오류): `Issue #44 · Migrate config schema` — 상태 `Issue failed`, 오류 메시지 노출
  - 작업 D (완료): `PR #41 · Add capability preflight` — 상태 `workflow done`

### 2.3 5개 디자인 후보군 종합 비교표

| 평가 항목 | 1. Classic (`classic`) | 2. Crimson Signal (`crimson`) | 3. Minimal Workspace (`minimal`) | 4. Developer Console (`console`) | 5. Editorial / Industrial (`editorial`) |
| --- | --- | --- | --- | --- | --- |
| **핵심 컨셉** | 기존 MAO 기본 웜 스톤 & 버밀리온 | **붉은색(버건디/크림슨) 베이스 + 노란색(앰버/골드) 액션·포인트** | 무채색 종이·잉크 질감의 미니멀 워크스페이스 | 차콜·슬레이트 기반 고밀도 기술 콘솔 | 굵은 그리드 루프와 대형 타이포그래피 중심 브루탈리즘 |
| **Light 스와치** (`bg` / `surface` / `text` / `accent` / `highlight`) | `#f3f2f2` / `#eae9e9` / `#201e1d` / `#ec3013` / `#e15b47` | `#f6eeee` / `#ede0e0` / `#261214` / `#9e1b24` / `#f5b82e` | `#fafafa` / `#f1f1f1` / `#171717` / `#262626` / `#525252` | `#eef1f5` / `#e2e7ee` / `#111822` / `#0b6bcb` / `#0891b2` | `#f4f1ea` / `#e9e4d8` / `#141413` / `#141413` / `#b84a1b` |
| **Dark 스와치** (`bg` / `surface` / `text` / `accent` / `highlight`) | `#1a1817` / `#262322` / `#f3f2f2` / `#ff6a4a` / `#ff8f78` | `#180c0e` / `#251317` / `#f7ecec` / `#f5b82e` / `#c92a3a` | `#121212` / `#1c1c1c` / `#f5f5f5` / `#e5e5e5` / `#a3a3a3` | `#0f1318` / `#171d24` / `#e6edf3` / `#38bdf8` / `#f59e0b` | `#141413` / `#1f1e1c` / `#f4f1ea` / `#f4f1ea` / `#e06d3b` |
| **타이포그래피 & 정보 밀도** | Archivo 헤딩(800) + 15px 본문, 표준 밀도 | 디스플레이 헤딩 + 따뜻한 본문, 표준 밀도, 앰버 포커스 링 | 산세리프 단일 계층, 넓은 여백, 낮은 밀도 | 고정폭 메타데이터 강조, 14px 컴팩트 본문, 높은 정보 밀도 | 초대형 섹션 타이틀, 두꺼운 2~3px 구획선, 낮은 카드 밀도 |
| **WCAG 대비율 (본문 텍스트 vs `bg` / `surface`)** | Light `14.8:1` (`13.6:1`) / Dark `14.8:1` (`12.8:1`) — AAA 통과 | Light `14.2:1` (`12.3:1`) / Dark `15.1:1` (`13.0:1`) — AAA 통과 | Light `16.9:1` (`15.6:1`) / Dark `16.1:1` (`14.3:1`) — AAA 통과 | Light `15.4:1` (`13.9:1`) / Dark `14.6:1` (`12.8:1`) — AAA 통과 | Light `15.2:1` (`13.7:1`) / Dark `15.2:1` (`13.5:1`) — AAA 통과 |
| **장점** | 기존 사용자에게 친숙하며 회귀 위험이 없음 | 라이트·다크 모두 버건디/크림슨 베이스 위에 웜 앰버/골드 액션·선택 포인트가 선명히 대비됨 | 시각적 노이즈가 가장 적음 | 다중 에이전트 큐·프롬프트·SHA 비교에 가장 높은 가독성 제공 | 첫인상이 강렬하고 에디토리얼 개성이 뚜렷함 |
| **단점** | 장시간 로그 분석 시 붉은 포인트가 강할 수 있음 | 채도 조절이 정교하지 않으면 오류 배지와 혼동될 수 있음 (전용 상태 토큰 및 기호로 해결) | 무채색 강조만으로는 칸반 보드의 `running`/`paused` 상태를 즉시 찾기 어려움 | 따뜻한 톤을 선호하는 사용자에게는 차갑게 느껴질 수 있음 (`Classic`/`Crimson`으로 보완) | 두꺼운 보더와 큰 제목이 칸반 3컬럼 및 모달 내부 공간 효율을 떨어뜨림 |
| **컴포넌트 재사용성 / 구현 비용** | 100% 재사용 / 추가 비용 없음 | 100% 재사용 / 시맨틱 토큰 분리로 구현 가능 | 100% 재사용 / 낮음 | 100% 재사용 / 폰트·밀도·보더 토큰화로 구현 가능 | 레이아웃 여백 재조정이 필요해 비용이 상대적으로 높음 |
| **최종 구분** | **선택 가능 프리셋 (`classic`, 기본값)** | **선택 가능 프리셋 (`crimson`)** | **탐색 전용 후보 (`minimal`)** | **선택 가능 프리셋 (`console`)** | **탐색 전용 후보 (`editorial`)** |

### 2.4 동일 샘플 데이터 기준 4개 핵심 화면별 표현 및 접근성 검증

| 대상 화면 (샘플 데이터) | 1. Classic (`classic`) | 2. Crimson Signal (`crimson`) | 3. Minimal Workspace (`minimal` — 탐색 전용) | 4. Developer Console (`console`) | 5. Editorial / Industrial (`editorial` — 탐색 전용) |
| --- | --- | --- | --- | --- | --- |
| **`Sidebar`** (`acme/widgets` 선택, `acme/cli-tools` 비활성, 스토어 경고 카드) | 웜 스톤 패널(`#eae9e9` / `#262322`) + 2px 구분선, 선택 행 `acme/widgets`는 버밀리온 배경으로 강조 | 로즈-옥사이드(Light `#ede0e0`) / 딥 버건디(Dark `#251317`) 패널 + 크림슨 구분선, 선택 행 `acme/widgets`는 **라이트·다크 모두 웜 앰버 골드(`#f5b82e`) 배경 + 다크 버건디 텍스트(`#261214` / `#180c0e`)**로 강조 | 연회색 패널 + 흑백 반전 선택 행; 스토어 경고와 일반 카드의 경계 구분이 약함 | 슬레이트 패널(`#e2e7ee` / `#171d24`) + 1px 정밀 보더, 선택 행은 코발트/시안(`#0b6bcb` / `#38bdf8`)으로 표시 | 크림색/흑색 패널 + 3px 외곽선, 좁은 260px 폭 안에서 텍스트 여백이 부족함 |
| **`KanbanBoard`** (`Issue #42 PR running`, `PR #43 Review paused`, `Issue #44 Issue failed`, `PR #41 workflow done`) | `.card-active`가 버밀리온 펄스 링으로 표시되고 상태 배지 4종이 분리됨 | 크림슨/버건디 카드 표면 위에서 실행 중 `Issue #42`가 **앰버 골드(`#f5b82e`) 펄스 링**으로 부각되고, `Issue failed`(`✕` + 루비/로즈 보더), `Review paused`(`⚠` + 브론즈/앰버 보더), `workflow done`(`✓` + 에메랄드 보더)이 명확히 구별됨 | 무채색 테두리 위주라 3개 컬럼에 카드가 많을 때 `Issue #42` 실행 중 카드를 한눈에 찾기 어려움 | 컴팩트한 카드 패딩과 고정폭 메타 라인(`Claude · claude-sonnet-4-6`) 덕분에 한 화면에 더 많은 이슈/PR 카드가 노출됨 | 굵은 카드 제목이 2~3줄로 줄바꿈되어 컬럼당 표시 가능한 카드 수가 감소함 |
| **`WorkflowQueue`** (큐 목록 + `<pre>` 프롬프트 펼침 + Retry/Run 액션 버튼) | 표준 카드 간격, 버밀리온 `Run`/`Retry` 버튼 | **웜 앰버 골드(`#f5b82e`) `Run`/`Retry` 주요 액션 버튼**과 크림슨 테두리가 조화를 이루며, 프롬프트 영역은 `--color-bg-subtle`(`#e5d4d5` / `#1e0f12`)로 깊이감 부여 | 깔끔하나 `Retry` 버튼과 보조 버튼의 중요도 차이가 작음 | `--font-mono` 고정폭 메타·프롬프트 블록과 슬레이트 배경(`#d6dde7` / `#12171d`)이 결합되어 긴 프롬프트·이력 검토에 최적 | 두꺼운 구분선이 이력 행마다 반복되어 스크롤 길이가 길어짐 |
| **`GlobalSettings`** (`Theme`: Light/Dark/System, `Design`: 프리셋 카드 + 5색 스와치, AI 프로바이더 편집) | 기본 선택 카드로 표시되며 웜 스톤/버밀리온 스와치 제공 | `Red · Yellow` 배지와 함께 크림슨 베이스 + 앰버 골드 포인트 스와치를 표시, `Save settings` 버튼이 골드 포인트로 강조됨 | 후보 비교 문서에만 수록 (런타임 선택기 미노출) | `High density` 배지와 슬레이트·시안·앰버 스와치를 표시, 프로바이더 입력 폼이 1px 보더로 정돈됨 | 후보 비교 문서에만 수록 (런타임 선택기 미노출) |

---

## 3. 구현 대상 선정 근거 및 구분

코드(`core/design-system.ts`)와 설정 UI에서 **실제 선택 가능한 디자인 프리셋(`DESIGN_PRESETS`)**과 **탐색 전용 후보(`EXPLORED_DESIGN_CANDIDATES`)**를 명확히 분리합니다.

### 3.1 실제 선택 가능한 디자인 프리셋 (`DESIGN_IDS = ['classic', 'crimson', 'console']`)
1. **`Classic` (`classic` — 기본값)**
   - 기존 사용자의 시각적 경험과 테스트 기대치를 100% 보존하기 위해 기본값(`DEFAULT_DESIGN_ID = 'classic'`)으로 유지합니다. 저장소에 `design` 필드가 없거나 알 수 없는 값이 들어온 경우에도 항상 `classic`으로 안전하게 폴백합니다.
2. **`Crimson Signal` (`crimson` — 레드·옐로 디자인)**
   - 이슈 #108의 핵심 요구사항인 **붉은색 계열을 주조색(베이스 표면·구조 경계선·브랜드 액센트)으로, 노란색을 주요 액션·선택 상태·핵심 강조 포인트로 사용하는 디자인**입니다.
   - 고채도 순수 적색(`#ff0000`)이나 순수 황색(`#ffff00`)을 넓은 면적에 그대로 쓰면 눈의 피로와 텍스트 대비 저하가 발생하므로, **Light 모드**에서는 따뜻한 로즈-옥사이드 배경(`#f6eeee` / `#ede0e0`)과 딥 크림슨 브랜드 액센트(`#9e1b24`)를 주조로 삼고, **Dark 모드**에서는 딥 버건디-옥사이드 배경(`#180c0e` / `#251317`)과 크림슨 구조선(`#c92a3a`)을 주조로 삼습니다. 그리고 **Light·Dark 양쪽 모두에서 주요 액션 버튼(`.btn-primary`), 활성 내비게이션(`.sidebar-item.active`), 포커스 링(`--color-focus`), 실행 중 카드 하이라이트에 웜 앰버 골드(`#f5b82e` / `#ffd24c`)**를 일관되게 사용하여 레드 베이스 + 옐로 포인트의 정체성과 `8.9:1` 이상의 높은 텍스트 대비율을 동시에 달성했습니다.
3. **`Developer Console` (`console` — 추가 선정 디자인)**
   - 후보군 비교 결과, MAO의 주 사용 시나리오인 **다중 저장소 칸반 트리아지, 워크플로 큐 모니터링, AI 에이전트 프롬프트/로그 검증**에서 가장 높은 실용성과 대비 효용을 보여준 후보입니다.
   - 따뜻한 스톤 톤(`Classic`) 및 강렬한 레드·옐로(`Crimson Signal`)와 시각적 축이 확실히 구분되는 쿨 슬레이트·차콜 기반 고밀도 기술 워크스페이스를 제공하여, 사용자의 작업 성향과 조명 환경에 따른 실질적인 선택권을 보장합니다.

### 3.2 탐색 전용 후보 (`EXPLORED_DESIGN_CANDIDATES = ['minimal', 'editorial']`)
- **`Minimal Workspace` (`minimal`)**: 무채색 중심의 절제된 인상은 우수하나, 여러 단계(`issue`, `pr`, `review`, `merge`)와 상태(`running`, `paused`, `error`, `done`)가 동시에 움직이는 칸반 보드에서 시선 유도력이 부족하여 런타임 프리셋에서는 제외하고 탐색 후보로 기록합니다.
- **`Editorial / Industrial` (`editorial`)**: `Classic`이 이미 강한 직각 모서리(`0px`)와 굵은 헤딩의 장점을 포함하고 있어, 과도한 보더 두께로 정보 밀도를 낮추는 별도 프리셋을 추가하는 대신 `Classic`과 `Developer Console`의 명확한 대비를 유지하는 편이 유지보수성과 사용성 면에서 유리합니다.

---

## 4. 의미 기반 토큰 체계 및 상태 식별 규칙

### 4.1 디자인 선택(`data-design`)과 테마 모드(`data-theme`)의 직교 구조
- `<html>` 루트 엘리먼트는 두 개의 독립 속성을 가집니다:
  - `data-theme="light" | "dark"`: 명암 모드 (`ThemePreference`: `'light' | 'dark' | 'system'`에서 해석됨)
  - `data-design="classic" | "crimson" | "console"`: 디자인 시스템 프리셋 (`DesignId`)
- 모든 디자인 프리셋은 Light 모드와 Dark 모드 토큰 세트를 1:1로 완비하므로, 총 `3 (디자인) × 2 (명암) = 6`가지 조합이 누락 없이 동작합니다.

### 4.2 시맨틱 CSS 토큰 계약 (`src/index.css`)

| 시맨틱 토큰 | 역할 | `classic` (Light / Dark) | `crimson` (Light / Dark) | `console` (Light / Dark) |
| --- | --- | --- | --- | --- |
| `--color-bg` | 앱 전체 기본 캔버스 배경 | `#f3f2f2` / `#1a1817` | `#f6eeee` / `#180c0e` | `#eef1f5` / `#0f1318` |
| `--color-surface` | 카드, 사이드바, 입력창 표면 | `#eae9e9` / `#262322` | `#ede0e0` / `#251317` | `#e2e7ee` / `#171d24` |
| `--color-bg-subtle` | 중첩 카드, 비활성 행, 코드/프롬프트 블록 배경 | `#e2e0df` / `#1f1c1b` | `#e5d4d5` / `#1e0f12` | `#d6dde7` / `#12171d` |
| `--color-text` | 기본 본문 및 제목 전경색 (AAA `>= 12:1`) | `#201e1d` / `#f3f2f2` | `#261214` / `#f7ecec` | `#111822` / `#e6edf3` |
| `--color-text-muted` | 보조 설명, 메타데이터, 캡션 전경색 (AA `>= 4.8:1`) | `#5c5755` / `#b8b2b0` | `#664246` / `#c9aeb0` | `#475569` / `#94a3b8` |
| `--color-border` | 카드·입력창·중첩 컨테이너 1px 경계선 | `#cfcaca` / `#3d3836` | `#cfb3b5` / `#4a232a` | `#c1cbd7` / `#2a3441` |
| `--color-divider` | 사이드바/탭/수평선 구조 구분선 | `rgb(32 30 29 / 0.4)` / `rgb(243 242 242 / 0.16)` | `rgb(38 18 20 / 0.36)` / `rgb(247 236 236 / 0.2)` | `rgb(17 24 34 / 0.28)` / `rgb(230 237 243 / 0.16)` |
| `--border-structural-width` | 사이드바/탭/수평선 구조 보더 두께 | `2px` / `2px` | `2px` / `2px` | `1px` / `1px` |
| `--color-accent` | 인라인 링크, 활성 탭 텍스트, 키커, 라이브 인디케이터 | `#ec3013` / `#ff6a4a` | `#9e1b24` / `#f5b82e` | `#0b6bcb` / `#38bdf8` |
| `--color-highlight` | 보조 강조 포인트 및 액티브 카드 펄스 외곽 링 | `#e15b47` / `#ff8f78` | `#f5b82e` / `#c92a3a` | `#0891b2` / `#f59e0b` |
| `--color-action-bg` | 주요 액션 버튼(`.btn-primary`) 및 선택 행(`.sidebar-item.active`) 배경 | `#ec3013` / `#ff6a4a` | `#f5b82e` / `#f5b82e` | `#0b6bcb` / `#38bdf8` |
| `--color-action-hover` | 주요 액션 버튼 호버 배경 | `#dd2b0f` / `#ff8465` | `#e5a519` / `#e5a519` | `#0958a8` / `#7dd3fc` |
| `--color-action-text` | `--color-action-bg` 위의 전경 텍스트 (AA/AAA 통과) | `#f3f2f2` / `#1a1817` | `#261214` / `#180c0e` | `#f8fafc` / `#09111a` |
| `--color-action-border` | 주요 액션 버튼 및 선택 행 경계선 | `transparent` / `transparent` | `#9e1b24` / `#ffd24c` | `transparent` / `transparent` |
| `--color-focus` | `:focus-visible` 키보드 포커스 아웃라인 | `#ec3013` / `#ff8465` | `#b87d00` / `#ffd24c` | `#0b6bcb` / `#38bdf8` |
| `--color-danger-bg` / `--color-danger-text` / `--color-danger-border` | 실패(`error`) 태그(`.tag-danger`) 및 오류 알림 | `#fce8e6`·`#9e1600`·`#d93025` / `#3b1414`·`#fca5a5`·`#ef4444` | `#fde8e8`·`#8c0b15`·`#b91c1c` / `#451219`·`#fecdd3`·`#fb7185` | `#fee2e2`·`#991b1b`·`#dc2626` / `#3b1219`·`#fca5a5`·`#ef4444` |
| `--color-warn-bg` / `--color-warn-text` / `--color-warn-border` | 일시정지(`paused`) 태그(`.tag-warn`) 및 주의 알림 | `#fef3c7`·`#854d0e`·`#d97706` / `#38260b`·`#fcd34d`·`#f59e0b` | `#fff3cd`·`#784200`·`#b45309` / `#3b2607`·`#fde68a`·`#fbbf24` | `#fef3c7`·`#92400e`·`#d97706` / `#382408`·`#fcd34d`·`#f59e0b` |
| `--color-success-bg` / `--color-success-text` / `--color-success-border` | 완료(`done`) 상태 배지(`.tag-success`) | `#dcfce7`·`#14532d`·`#16a34a` / `#0f2e1c`·`#86efac`·`#22c55e` | `#dcfce7`·`#14532d`·`#15803d` / `#0d2e1b`·`#86efac`·`#34d399` | `#dcfce7`·`#166534`·`#16a34a` / `#0c2d1c`·`#86efac`·`#22c55e` |
| `--font-heading` | 섹션 타이틀, 카드 제목, 버튼 타이포그래피 | `'Archivo', system-ui, -apple-system, sans-serif` | `'Archivo', system-ui, -apple-system, sans-serif` | `'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', monospace` |
| `--font-body` | 기본 본문 및 입력 컨트롤 타이포그래피 | `'Archivo', system-ui, -apple-system, sans-serif` | `'Archivo', system-ui, -apple-system, sans-serif` | `system-ui, -apple-system, 'Segoe UI', sans-serif` |
| `--font-mono` | 프롬프트(`<pre>`), 코드 블록, 키커, 텔레메트리 | `'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', monospace` | 동일 | 동일 |

### 4.3 브랜드 색상(레드·옐로)과 의미 상태(오류·경고·진행·완료)의 시각적 분리 규칙
특히 `Crimson Signal`(`crimson`)에서 브랜드 색상인 붉은색·노란색이 시스템 상태와 혼동되지 않도록 다음 3가지 원칙을 동시에 적용합니다.

1. **전용 상태 토큰 분리**:
   - 작업 실패(`status === 'error'`)는 브랜드 `.tag-accent` 대신 전용 `.tag-danger`(`--color-danger-*`)를 사용하여 배경 채도·보더 두께·전경 명도를 일반 브랜드 태그와 분리합니다.
   - 작업 완료(`status === 'done'`)는 `.tag-success`(`--color-success-*`)를 사용하여 대기(`pending`, `.tag-neutral`)와 명확히 구분합니다.
   - 일시정지(`status === 'paused'`)는 `.tag-warn`(`--color-warn-*`)을 사용합니다.
   - 실행 중(`status === 'running'`)은 `.tag-outline` + `.live-dot` 애니메이션 + `.card-active` 외곽선 펄스를 조합합니다.
2. **비색상(Non-color) 상태 식별자 병행**:
   - 색각 이상 사용자나 단색 환경에서도 상태를 오인하지 않도록 모든 상태 배지는 명시적 텍스트(`Issue failed`, `PR running`, `Review paused`, `workflow done`)와 함께 시각적 상태 기호(`✕` 실패, `⚠` 일시정지/주의, `●` 실행 중 펄스 점, `✓` 완료) 및 보더 스타일 차이(실선/배경 채움/외곽선)를 함께 유지합니다.
3. **일관된 포커스 및 상호작용 피드백**:
   - 모든 버튼(`.btn`), 입력 컨트롤(`.input`), 탭(`.tab`), 사이드바 항목(`.sidebar-item`), 디자인 선택 카드(`.design-option`)는 `:focus-visible` 시 `2px solid var(--color-focus)`와 `outline-offset: 2px`를 표시하여 키보드 탐색 시 현재 위치를 놓치지 않게 합니다.

---

## 5. 아키텍처 연동 및 검증 요약

### 5.1 Core · Store · IPC · CLI · Renderer 동기화
- **단일 순수 계약 (`core/design-system.ts`)**: Node 내장 모듈이나 런타임 `core/` 의존성이 없는 순수 모듈로, `DESIGN_IDS` (`'classic'`, `'crimson'`, `'console'`), `DEFAULT_DESIGN_ID` (`'classic'`), `DESIGN_PRESETS`, `EXPLORED_DESIGN_CANDIDATES` (`'minimal'`, `'editorial'`), `isDesignId()`, `normalizeDesignId()`, `getDesignPreset()`를 정의합니다.
- **영속화 및 폴백 (`core/store.ts`)**: `MaoStoreSchema.design` 필드를 추가하고 기본값을 `'classic'`으로 설정했습니다. 손상되거나 알 수 없는 문자열이 `config.json`에 저장되어 있어도 `normalizeDesignId()`를 통해 워크플로 큐를 멈추지 않고 안전하게 `'classic'`으로 폴백합니다.
- **IPC 및 Preload 락스텝 (`electron/ipc.ts`, `electron/preload.ts`, `src/electron.d.ts`, `src/test/electron-api-stub.ts`)**: `ui:getDesign` 및 `ui:setDesign` 핸들러를 추가하고, `src/electron-ipc-surface.test.ts` AST 검증을 통과하도록 브리지 표면과 이름을 일치시켰습니다.
- **GUI↔CLI 패리티 (`cli/index.ts`, `src/App.tsx`, `src/components/GlobalSettings.tsx`)**:
  - CLI에서 `mao config set-design <classic|crimson|console>` 및 `mao config show`의 `"design"` 필드로 디자인 프리셋을 조회·변경할 수 있습니다.
  - 렌더러(`src/App.tsx`)는 마운트 시 `electronApi().ui.getDesign()`을 읽어 `<html data-design="...">`에 반영하며, 저장 실패 시 이전 디자인 상태로 롤백하고 `role="alert"`로 오류를 표시합니다. 이때 `GlobalSettings`에 입력 중이던 미저장 GitHub 토큰이나 AI 프로바이더 편집 상태는 그대로 보존됩니다.

### 5.2 검증 게이트 결과 요약
- `npm run lint` (`tsc --noEmit`): 타입 및 IPC 브리지 `satisfies Window['electronAPI']` 검증 통과
- `npm run test`:
  - `vitest --project core`: `core/design-system.test.ts` (WCAG AAA 대비율 및 프리셋/후보군 검증) 및 `core/store.test.ts` (`design` 영속성·폴백 검증) 포함 전체 통과
  - `vitest --project renderer`: `src/App.test.tsx`, `src/components/GlobalSettings.test.tsx`, `src/electron-ipc-surface.test.ts` 포함 전체 통과
  - `python3 -m unittest discover -s .agents/workflows -p "*_test.py"`: Swarm 오케스트레이터 안전성 회귀 테스트 통과
- `npm run test:origin`: 원격 저장소 URL 검증 매트릭스 통과
- `npx vite build` & `npm run build:cli`: 렌더러 프로덕션 번들 및 CLI 번들(`dist-cli/index.cjs`) 빌드 성공, 임시 `MAO_DATA_DIR` 격리 환경에서 `config show` / `config set-design` 정상 및 오류 종료 코드(1) 동작 확인
