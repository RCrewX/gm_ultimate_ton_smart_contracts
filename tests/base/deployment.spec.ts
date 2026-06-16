// SPDX-License-Identifier: UNLICENSED
import '@ton/test-utils';
import { ContractSystem, initContractSystem, setupCoordinateCellWithFirstExplorer, cleanupContractSystem } from '../test_utils';

describe('Deployment', () => {
    let SC_System: ContractSystem;

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('should deploy CoordinateCell', async () => {
        const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });
        expect(coordinateCell.address).toBeDefined();
    });

    it('should deploy Ship', async () => {
        // Ship deployment is done in initContractSystem
        expect(SC_System.ownerShip.address).toBeDefined();
    });

    it('should deploy Game', async () => {
        // Game deployment is done in initContractSystem
        expect(SC_System.game.address).toBeDefined();
    });

    it('should deploy GameManager', async () => {
        // GameManager deployment is done in initContractSystem
        expect(SC_System.gameManager.address).toBeDefined();
    });
});

