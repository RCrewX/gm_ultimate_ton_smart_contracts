// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano, SendMode } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Subcontract } from '../../wrappers/subcontract/Subcontract';
import { GAS_COST_FORWARD, GAS_COST_FORWARD_WITH_INIT, encodeForward } from '../../wrappers/subcontract/types';
import { Ship, shipConfigToCell } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { encodeRequestToMove } from '../../wrappers/ton_race_game/types';
import { Opcodes } from '../../wrappers/ton_race_game/types';

describe('Subcontract - Nested and Deployment', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test nested subcontracts - owner -> subcontract -> subcontract -> ship', async () => {
        // Create first level subcontract (owned by owner)
        const firstLevelId = 100n;
        const firstLevelSubcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: firstLevelId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await firstLevelSubcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the first-level subcontract so it has enough balance for forwarding
        await SC_System.ownerAccount.send({
            to: firstLevelSubcontract.address,
            value: toNano('1'),
        });

        // Get address of second level subcontract (owned by first level)
        const secondLevelId = 200n;
        const secondLevelSubcontractAddress = await firstLevelSubcontract.getSubcontractAddress(secondLevelId);
        
        // Create and deploy second level subcontract
        const secondLevelSubcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: firstLevelSubcontract.address,
            id: secondLevelId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await secondLevelSubcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the second-level subcontract so it has enough balance for forwarding
        await SC_System.ownerAccount.send({
            to: secondLevelSubcontract.address,
            value: toNano('1'),
        });

        // Verify the address matches
        expect(secondLevelSubcontractAddress).toEqualAddress(secondLevelSubcontract.address);

        // Create ship owned by second level subcontract
        const shipForNestedSubcontract = SC_System.blockchain.openContract(Ship.createFromConfig({
            userAddress: secondLevelSubcontract.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        }, SC_System.shipCode));

        await shipForNestedSubcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('5'));

        // Create RequestToMove message
        const moveMessage = encodeRequestToMove({ mode: MoveMode.UP });
        const forwardAmount = toNano('1');

        // Create a Forward message to be sent to second level subcontract
        // The second level subcontract will forward the inner messageBody (RequestToMove) to ship
        const forwardToShipMessage = encodeForward({
            queryId: 0n,
            destination: shipForNestedSubcontract.address,
            forwardTonAmount: forwardAmount,
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messageBody: moveMessage,
        });

        // Forward through first level subcontract to second level subcontract
        // First level forwards the Forward message, second level extracts and forwards RequestToMove to ship
        // Second level needs GAS_COST_FORWARD + forwardAmount to process the Forward message
        // So first level needs: GAS_COST_FORWARD (for first level) + GAS_COST_FORWARD + forwardAmount (to forward to second level)
        const firstLevelValue = GAS_COST_FORWARD + GAS_COST_FORWARD + forwardAmount;
        SC_System.messageResult = await firstLevelSubcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            firstLevelValue,
            secondLevelSubcontract.address,
            forwardToShipMessage,
            GAS_COST_FORWARD + forwardAmount, // Second level needs gas + forwardAmount
            false, // NoBounce
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: firstLevelSubcontract.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: firstLevelSubcontract.address,
            to: secondLevelSubcontract.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: secondLevelSubcontract.address,
            to: shipForNestedSubcontract.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        // Verify ship processed the move
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: shipForNestedSubcontract.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });

    it('Test owner can deploy ship through subcontract and send moves - no separate sendDeploy needed', async () => {
        const subcontractId = 6n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));
        
        // Fund the subcontract so it has enough balance for forwarding
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.5'),
        });

        // Create ship config - ship will be owned by subcontract
        const shipConfig = {
            userAddress: subcontract.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        };

        // Create ship instance to get its address and init
        const shipForSubcontract = SC_System.blockchain.openContract(Ship.createFromConfig(
            shipConfig,
            SC_System.shipCode
        ));

        // Create stateInit cell for ship deployment
        // StateInit structure: stateInit$00 code:^Cell data:^Cell = StateInit;
        // stateInit$00 means: 2 bits = 00 (split_depth=0, special=null), then code ref, then data ref
        const shipData = shipConfigToCell(shipConfig);
        const shipStateInit = beginCell()
            .storeUint(0, 2) // stateInit$00 - 2 bits for 00 (split_depth=0, special=null)
            .storeRef(SC_System.shipCode) // code reference
            .storeRef(shipData) // data reference
            .endCell();

        // Deploy ship through subcontract using ForwardWithInit
        // No separate sendDeploy needed - subcontract handles deployment
        const deployAmount = toNano('5'); // Enough for ship deployment
        const deployBody = beginCell().endCell(); // Empty body for deploy
        // Need extra for subcontract's gas, reserve costs, and to maintain balance
        // reserveValue reserves (originalBalance - msgValue) + storageTax, so we need enough
        // to cover: gas cost + forward amount + reserve + storage tax
        const totalAmount = GAS_COST_FORWARD_WITH_INIT + deployAmount + toNano('0.5');

        SC_System.messageResult = await subcontract.sendForwardWithInit(
            SC_System.ownerAccount.getSender(),
            totalAmount,
            shipForSubcontract.address,
            shipStateInit,
            deployBody,
            deployAmount,
            SendMode.PAY_GAS_SEPARATELY
        );

        // Verify subcontract received and processed the message
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        // Verify ship was deployed by subcontract
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: shipForSubcontract.address,
            deploy: true,
            success: true,
        });

        // Now send move messages through subcontract using Forward
        const moveMessage = encodeRequestToMove({ mode: MoveMode.UP });
        const forwardAmount = toNano('1'); // Enough for ship move operation

        SC_System.messageResult = await subcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            shipForSubcontract.address,
            moveMessage,
            forwardAmount,
            false, // NoBounce
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        // Verify ship processed the move
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        // Send another move to verify it works multiple times
        SC_System.messageResult = await subcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            shipForSubcontract.address,
            encodeRequestToMove({ mode: MoveMode.UP }),
            forwardAmount,
            false,
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });

    it('Test user can use subcontracts to own multiple ships and get all init/deploy info from getters', async () => {
        // Create a user account (not the owner)
        const userAccount = await SC_System.blockchain.treasury('user');
        
        // User deploys their own subcontract
        const userSubcontractId = 1000n;
        const userSubcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: userAccount.address,
            id: userSubcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await userSubcontract.sendDeploy(userAccount.getSender(), toNano('1'));

        // User can get their subcontract address using the getter
        // First, get it from a deployed subcontract instance (to access the getter)
        const referenceSubcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: userAccount.address,
            id: userSubcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        // Verify the address matches
        expect(userSubcontract.address).toEqualAddress(referenceSubcontract.address);

        // User can also get subcontract address for any owner/id combination using get_subcontract_by_id_address
        // This allows users to calculate addresses without deploying
        // SandboxContract automatically provides the provider, so we only pass ownerAddress and id
        const calculatedAddress = await userSubcontract.getSubcontractByIdAddress(
            userAccount.address,
            userSubcontractId
        );
        expect(calculatedAddress).toEqualAddress(userSubcontract.address);

        // User can also get addresses of nested subcontracts (subcontracts owned by their subcontract)
        const nestedSubcontractId1 = 2000n;
        const nestedSubcontractId2 = 2001n;
        
        const nestedSubcontract1Address = await userSubcontract.getSubcontractAddress(nestedSubcontractId1);
        const nestedSubcontract2Address = await userSubcontract.getSubcontractAddress(nestedSubcontractId2);

        // Verify addresses are different for different IDs
        expect(nestedSubcontract1Address).not.toEqualAddress(nestedSubcontract2Address);

        // User can also use get_subcontract_by_id_address to get nested subcontract addresses
        const calculatedNested1 = await userSubcontract.getSubcontractByIdAddress(
            userSubcontract.address,
            nestedSubcontractId1
        );
        expect(calculatedNested1).toEqualAddress(nestedSubcontract1Address);

        // Deploy a ship through the user's subcontract
        const shipConfig = {
            userAddress: userSubcontract.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        };

        const ship = SC_System.blockchain.openContract(Ship.createFromConfig(shipConfig, SC_System.shipCode));

        // Get ship stateInit for deployment
        const shipData = shipConfigToCell(shipConfig);
        const shipStateInit = beginCell()
            .storeUint(0, 2)
            .storeRef(SC_System.shipCode)
            .storeRef(shipData)
            .endCell();

        // Deploy ship through subcontract
        const deployAmount = toNano('5');
        const totalAmount = GAS_COST_FORWARD_WITH_INIT + deployAmount + toNano('0.5');

        SC_System.messageResult = await userSubcontract.sendForwardWithInit(
            userAccount.getSender(),
            totalAmount,
            ship.address,
            shipStateInit,
            beginCell().endCell(),
            deployAmount,
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userAccount.address,
            to: userSubcontract.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userSubcontract.address,
            to: ship.address,
            deploy: true,
            success: true,
        });

        // Verify user can read all needed info from deployed subcontract
        const ownerAddress = await userSubcontract.getOwnerAddress();
        const id = await userSubcontract.getId();

        expect(ownerAddress).toEqualAddress(userAccount.address);
        expect(id).toBe(userSubcontractId);

        // User can calculate addresses for future subcontracts without deploying
        const futureSubcontractId = 3000n;
        const futureSubcontractAddress = await userSubcontract.getSubcontractByIdAddress(
            userAccount.address,
            futureSubcontractId
        );

        // Verify the calculated address matches what would be created
        const expectedFutureSubcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: userAccount.address,
            id: futureSubcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        expect(futureSubcontractAddress).toEqualAddress(expectedFutureSubcontract.address);

        // Verify ship is deployed and can receive messages
        // Send move request to ship through the subcontract
        const moveMessage = encodeRequestToMove({ mode: MoveMode.UP });
        const forwardAmount = toNano('1');

        SC_System.messageResult = await userSubcontract.sendForward(
            userAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            ship.address,
            moveMessage,
            forwardAmount,
            false,
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userSubcontract.address,
            to: ship.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        // Verify ship processed the move
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: ship.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });
});

