## Summary

<!-- A brief description of what this PR does and why. -->

## Related issue

<!-- Link to the issue this PR addresses, e.g. "Closes #123" or "Relates to #456". -->

## Type of change

<!-- Check the one that applies. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Refactor (no functional changes)
- [ ] Documentation update
- [ ] CI / build / tooling

## Checklist

<!-- Review each item and check the box when done. -->

### General

- [ ] `npm run lint` passes (`tsc --noEmit`)
- [ ] `npm run test` passes (vitest)
- [ ] `npm run test:origin` passes
- [ ] `npx vite build` passes
- [ ] `npm run build:cli` passes (if `cli/` or `core/` changed)
- [ ] I have not committed `.env`, tokens, or API keys

### Architecture (see AGENTS.md)

- [ ] `core/` has no Electron imports
- [ ] Business logic is in `core/`, not in `electron/` or `cli/` shells
- [ ] GUI ↔ CLI parity: feature is available in both frontends (or N/A)

### Lockstep files (check if you touched any)

- [ ] **New IPC channel** → updated all 3: `electron/ipc.ts`, `electron/preload.ts`, `src/electron.d.ts` + the fake bridge in `src/test/electron-api-stub.ts`
- [ ] **New store field** → updated both `MaoStoreSchema` and `MAO_STORE_DEFAULTS` in `core/store.ts`; a shape `config.json` can violate also needs a `STORED_SHAPE_RULES` entry + table test
- [ ] **New pipeline stage** → updated `AGENT_STAGES` in `core/ai/types.ts`, `STAGE_ROLE` in `core/agent-selection.ts`, `buildPromptForStage` + `applyGithubAction` in `core/workflow-engine.ts`, `STAGE_LABELS` in `src/components/KanbanBoard.tsx` and `src/components/WorkflowQueue.tsx`, `ALL_STAGES` + `STAGE_LABELS` in `src/components/GlobalSettings.tsx`, and `core/workflow-engine.test.ts`
- [ ] **Repository registration** → stayed a thin delegation to `updateRepos`; the add-vs-update rule lives only in `core/repo-registry.ts`
- [ ] **Repository capability policy** → audited `core/repo-capabilities.ts` and `.agents/workflows/swarm_orchestrator.py` together, with regressions in both suites
- [ ] **Build output rename** → audited `electron/main.ts`, `vite.config.ts`, `package.json`
- [ ] **Closed a documented gap or moved a rule** → moved or deleted the matching entry in `AGENTS.md` or `.agents/skills/mao-development/` in the same commit

### UI changes (if applicable)

- [ ] Design tokens use CSS variables from `src/index.css`, no hardcoded hex
- [ ] Semantic classes (`.btn`, `.card`, `.tag`) used where appropriate
- [ ] No `rounded-*` (project uses `--radius-md: 0px`)
- [ ] Renderer **behaviour** change → covered by a test under `src/**/*.test.tsx`, mounted against `createElectronApiStub()` (`tsc --noEmit` and a green `vite build` prove nothing about what the UI does)

## Screenshots / recordings

<!-- If applicable, add screenshots or recordings to show visual changes. -->

## Notes for reviewers

<!-- Any additional context that would help the reviewer. -->
