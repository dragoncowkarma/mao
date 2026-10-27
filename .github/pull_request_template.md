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

- [ ] **New IPC channel** → updated all 3: `electron/ipc.ts`, `electron/preload.ts`, `src/electron.d.ts`
- [ ] **New store field** → updated both `MaoStoreSchema` and `MAO_STORE_DEFAULTS` in `core/store.ts`
- [ ] **New pipeline stage** → updated `AGENT_STAGES` in `core/ai/types.ts`, `buildPromptForStage`, `applyGithubAction` in `core/workflow-engine.ts` + the stage name in `stages` in `src/i18n/messages/common.ts` (every language) + `ALL_STAGES` in `GlobalSettings.tsx` + tests
- [ ] **New UI language** → added to `UI_LANGUAGES` in `core/ui-language.ts` + every catalog in `src/i18n/messages/` + `MESSAGES`/`LANGUAGE_NAMES` in `src/i18n/index.ts`
- [ ] **Build output rename** → audited `electron/main.ts`, `vite.config.ts`, `package.json`

### UI changes (if applicable)

- [ ] Design tokens use CSS variables from `src/index.css`, no hardcoded hex
- [ ] Semantic classes (`.btn`, `.card`, `.tag`) used where appropriate
- [ ] No `rounded-*` (project uses `--radius-md: 0px`)
- [ ] New user-visible text added to the component's catalog in `src/i18n/messages/` for every language (no literal text in TSX — `src/i18n/no-hardcoded-text.test.ts`)
- [ ] Renderer **behaviour** change → covered by a test under `src/**/*.test.tsx`, mounted against `createElectronApiStub()` (`tsc --noEmit` and a green `vite build` prove nothing about what the UI does)

## Screenshots / recordings

<!-- If applicable, add screenshots or recordings to show visual changes. -->

## Notes for reviewers

<!-- Any additional context that would help the reviewer. -->
