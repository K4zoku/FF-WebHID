export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Replaces compilerla/conventional-pre-commit: same 11 types, optional
    // scope, subject required. The old hook had no case or length limits.
    'subject-case': [0],
    'header-max-length': [1, 'always', 100],
  },
  ignores: [
    // The old hook skipped merge commits and autosquash prefixes.
    (message) => /^merge\b/i.test(message),
    (message) => /^(amend|fixup|squash)! /.test(message),
  ],
};
