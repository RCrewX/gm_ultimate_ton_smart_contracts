// SPDX-License-Identifier: UNLICENSED
import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    globalSetup: './jest.setup.ts',
    cache: false, // disabled caching to prevent old Tact files from being used after a rebuild
    testEnvironment: '@ton/sandbox/jest-environment',
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    reporters: ['default', ['@ton/sandbox/jest-reporter', {}]],
    maxWorkers: 1, // Run tests sequentially, one test file after another
    // Force test isolation - each test file runs in a separate process
    // This helps prevent memory leaks from accumulating
    forceExit: true,
    // Clear mocks and timers after each test
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,
};

export default config;
