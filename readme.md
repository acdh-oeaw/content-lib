# content lib

## Development tooling

Run `pnpm install` to install dependencies and the Lefthook pre-commit hook. The hook runs Oxlint
fixes followed by Oxfmt on staged files and stages the fixes. Lefthook preserves unstaged changes in
partially staged files.

- `pnpm format:check` / `pnpm format:fix`: check or apply formatting, including import sorting.
- `pnpm lint:check` / `pnpm lint:fix`: check or fix lint issues, including type-aware TypeScript
  rules.
- `pnpm types:check`: run TypeScript across the workspaces.

Build first with `pnpm build` when checking types or linting a fresh checkout: the examples import
the library's built declarations and generated content.

Formatting and linting share root configurations in `.oxfmtrc.json` and `.oxlintrc.json`. The Oxlint
configuration carries over supported ESLint rules, including React, accessibility, and Next.js
rules. The previous regexp, Playwright, Tailwind CSS, and additional React/Node plugin checks are
not fully covered by native Oxlint rules. Oxfmt handles import sorting; JSX prop sorting is no
longer enforced.

The workspace uses TypeScript 7 and tsdown 0.23.7. Declaration generation uses the existing
`isolatedDeclarations` configuration.

For VS Code, install the recommended TypeScript 7 extension (`TypeScriptTeam.native-preview`). The
workspace settings point its language service at the local TypeScript package.
