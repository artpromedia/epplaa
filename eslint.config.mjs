// ESLint flat-config skeleton for the Epplaa monorepo.
//
// This file is a placeholder that codifies the *target* lint topology
// for the v4.2 evolution (see docs/adr/0002-repository-layout.md) but
// does not yet enforce any rules. ESLint is intentionally not yet a
// root devDependency — adding it would churn the lockfile and is
// scheduled as its own follow-up PR per the Phase 0 checklist in
// docs/architecture/v4.2-amendment.md.
//
// When ESLint is wired in, this file will export a flat config array
// that:
//   1. Applies @typescript-eslint recommended rules to every package
//      under apps/, services/, packages/, scripts/, and (during
//      migration) artifacts/ and lib/.
//   2. Layers per-tree overrides — React rules for apps/, Node rules
//      for services/, test-file relaxations for **/*.{test,spec}.ts.
//   3. Ignores generated artefacts (dist/, build/, .next/, coverage/,
//      node_modules/, .turbo/, .expo/).
//
// Until that lands, exporting an empty config is the documented
// no-op shape. Tools that locate eslint.config.mjs (editor plugins,
// future CI step) will find a valid file rather than failing on a
// missing one.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.expo/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
];
