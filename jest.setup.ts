// SPDX-License-Identifier: UNLICENSED
// Increase max listeners to prevent warnings during tests
// This is needed because Jest and TON Sandbox create many event listeners
// Must be set before any imports that might add listeners
process.setMaxListeners(100);

import { buildAllTact } from '@ton/blueprint';

export default async function () {
    await buildAllTact();
}
