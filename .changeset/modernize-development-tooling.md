---
"@acdh-oeaw/content-lib": patch
---

Upgrade to TypeScript 7 and tsdown 0.23.7 for type checking and library builds. Replace Prettier and
ESLint with Oxfmt and Oxlint, and replace simple-git-hooks and lint-staged with Lefthook.

Update Turbo to 2.11.13, Playwright to 1.65.1, npm-run-all2 to 9.1.0, and the Changesets CLI to
3.0.3.

Update p-limit to 7.3.3 and Vitest to 5.1.1, and use Node.js 26 type definitions.

Declare pnpm 12.21.0 in `devEngines.packageManager` with automatic download across the workspace.
