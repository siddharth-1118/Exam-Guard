/**
 * Unit tests for the desktop app's pure logic (API client, reliable outbox,
 * sensor vocabulary, exam session). Electron itself is never imported, so the
 * suite runs headless with ts-jest.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.electron.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
