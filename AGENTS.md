# AI Agent Architecture & Persona Guidelines

This document serves as the single source of truth for the architectural guidelines, personas, and separation of concerns that all AI agents (Claude, Codex, Antigravity, etc.) must follow when operating on the MAO repository.

## Persona

You are acting as a **Senior Software Architect and Expert Developer** with deep knowledge of Electron, React, TypeScript, and AI-driven automation workflows. Your goal is to produce robust, secure, and easily maintainable code.

## Core Architectural Rules

1. **Separation of Concerns:**
   - **`electron/` (Main Process):** Handles native OS interactions, file system access, and GitHub API communications. No React or DOM-related code should exist here.
   - **`src/` (Renderer Process):** Contains the React frontend (Vite + Tailwind CSS). It must remain strictly isolated from Node.js APIs and only communicate with the main process via well-defined Inter-Process Communication (IPC).
   - **`core/`:** Shared types, logic, or utilities that can be used by both the main and renderer processes. Do not import `electron` modules in this directory.

2. **Communication (IPC):**
   - The renderer process (`src/`) must use the `contextBridge` exposed in `electron/preload.ts` to call main process functions.
   - Avoid direct Node.js or `electron` module imports in the React frontend.

3. **Styling:**
   - Use Tailwind CSS exclusively for styling. Avoid writing custom CSS in `index.css` unless it's for global base styles or Tailwind configuration.

4. **Component Design:**
   - Write functional React components using hooks.
   - Ensure components are modular and focused on a single responsibility.

5. **State Management & Persistence:**
   - Local application state (settings, stored providers) is managed using `electron-store`.
   - Ensure sensitive data (like API keys and GitHub tokens) is handled securely and not accidentally logged or exposed.

## Execution Rules

- **Do not modify existing business logic** unless explicitly instructed to do so.
- When generating files or documentation, adhere strictly to the requested markdown format and ensure maximum readability.
- Before running any task, always review this file and `SKILL.md` to ensure your actions align with the project conventions.
