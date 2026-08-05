# AI Agent Skills and Workflows

This document outlines the standard commands, workflows, and procedures that AI agents should utilize when contributing to the MAO project.

## Development Scripts

The following commands are defined in `package.json` and should be used during development:

- **Start Development Server:**
  ```bash
  npm run dev
  ```
  Starts the Vite development server with hot reload for the Electron app.

- **Build Application:**
  ```bash
  npm run build
  ```
  Creates a fast, unpacked build (`release/mac`) for local testing.

  ```bash
  npm run dist
  ```
  Creates a full distributable package (e.g., dmg + zip for Mac).

- **Build CLI Tool:**
  ```bash
  npm run build:cli
  ```
  Bundles the CLI tool to `dist-cli/index.cjs`.

- **Run CLI Tool:**
  ```bash
  npm run cli
  ```
  Executes the built CLI tool (`dist-cli/index.cjs`).

- **Run Tests:**
  ```bash
  npm run test
  ```
  Executes Vitest tests. Ensure tests pass before submitting any pull requests.

- **Run Linter:**
  ```bash
  npm run lint
  ```
  Runs TypeScript compiler checks (`tsc --noEmit`).

## AI-Driven GitHub Workflow (End-to-End)

When working on a feature or fixing a bug, agents should simulate the pipeline used by the MAO toolkit itself:

1. **Issue Creation:** Ensure an issue exists on GitHub for the task being worked on.
2. **Branching:** Check out a new branch related to the issue (e.g., `feature/ai-agent-setup`).
3. **Implementation & Testing:**
   - Write code adhering to the separation of concerns between `electron/`, `src/`, `cli/`, and `core/`.
   - Add or update unit tests to verify changes. **Note:** Tests must be placed in `core/` (e.g., `core/*.test.ts`) because `vitest.config.ts` is configured to only collect `core/**/*.test.ts`.
   - Run `npm run test` and `npm run lint`.
4. **Committing:**
   - Use Conventional Commits formatting (e.g., `feat(ui): add new kanban component`, `fix(core): resolve state race condition`).
5. **Pull Request:**
   - Create a Pull Request against the main branch.
   - In the PR body, summarize the changes, reference the related issue, and highlight any architectural decisions made.

## Test Workflow Harness

For testing the core workflow engine without the UI, you can run the standalone harness script:

```bash
node --experimental-strip-types --env-file=.env.test scripts/test-workflow.ts
```
*Note: This requires **Node >= 22.6** (for the `--experimental-strip-types` flag) and a `.env.test` file with valid configuration (test repository and API keys) as described in the main `README.md`.*

## AI Rules Reminder
Always cross-reference with `AGENTS.md` for architectural rules and constraints.
