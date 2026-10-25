// Lint config (flat). Correctness only: no formatting rules, and no prettier, because many sessions edit these
// files at once and a mass reformat would conflict with all of them. `npm run lint`; tests/lint.test.cjs runs it
// as part of `npm test`.
import js from '@eslint/js';
import globals from 'globals';

// Objects the frontend scripts share through window. One script defines each (window.X = ... or root.X = ...),
// others read it, so they are declared here instead of turning no-undef off.
const localAIGlobals = Object.fromEntries([
  'LocalAIUI', 'LocalAIRouter', 'LocalAIRuns', 'LocalAIRunBodies', 'LocalAIViews', 'LocalAIHome', 'LocalAIImprove',
  'LocalAIKit', 'LocalAIShell', 'LocalAIChat', 'LocalAIChatCore', 'LocalAIChanges', 'LocalAICommand', 'LocalAIPalette',
  'LocalAIImages', 'LocalAILegacy', 'LocalAIMissions', 'LocalAIMissionStream', 'LocalAIModels', 'LocalAISpecialists',
  'LocalAIFirstRun', 'LocalAIFocusNext', 'LocalAIOpen', 'LocalAIQR',
].map(name => [name, 'writable']));

const correctness = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-redeclare': 'error',
  'no-fallthrough': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  // An empty catch is this codebase's deliberate "best effort" idiom; other empty blocks are still reported.
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  // app/public/ui is the appliance-ui kit's synced copy: generated, and checked by its own verify.mjs.
  { ignores: ['node_modules/**', 'app/public/ui/**', 'tests/vendor/**', 'tests/visual/**', 'data/**', 'workspace/**', 'reports/**', 'releases/**'] },
  js.configs.recommended,
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    // Server, CLIs and Node tests.
    files: ['app/*.js', 'app/server/*.js', 'deploy/**/*.js', '**/*.cjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: correctness,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: correctness,
  },
  {
    // Browser scripts. Classic <script>s, so each file is a script; app/public/ui.js is a bundle whose
    // `// ==== name.js ====` sections are each wrapped in their own (() => { ... })() and so already have their own
    // scope (a name declared in one section is undefined in the next, and no-undef reports it).
    files: ['app/public/*.js', 'app/public/aw/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...localAIGlobals, module: 'readonly' },
    },
    rules: correctness,
  },
  { files: ['app/public/app.js'], languageOptions: { sourceType: 'module' } },
  {
    files: ['app/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // Playwright suites: page.evaluate callbacks run in the browser.
    files: ['tests/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...localAIGlobals } },
  },
];
