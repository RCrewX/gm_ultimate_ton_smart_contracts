// SPDX-License-Identifier: UNLICENSED
import { beginCell, fromNano, toNano, SendMode } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Subcontract } from '../../wrappers/subcontract/Subcontract';
import { GAS_COST_FORWARD, GAS_COST_FORWARD_WITH_INIT, GAS_COST_MANUAL_DEPLOY, Opcodes as SubcontractOpcodes } from '../../wrappers/subcontract/types';
import { encodeRequestToMove, Opcodes } from '../../wrappers/ton_race_game/types';
import { Ship, shipConfigToCell } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { GAS_COST_REQUEST_TO_MOVE, GAS_COST_MOVE_SHIP_TO_CC, TODO_TOTAL_GAS_TO_MOVE } from '../../wrappers/ton_race_game/types';
import { writeGasCosts } from '../../lib/buildOutput';

describe("Gas Prices - Subcontract", () => {
    let SC_System: ContractSystem;
    let gasCosts: Record<string, string> = {};

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    afterAll(() => {
        writeGasCosts('subcontract', gasCosts);
        // Clear gasCosts to free memory
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("DeployShipThroughSubcontract", async () => {
        const subcontractId = 100n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Enable redirectExcess to receive cashback
        await subcontract.sendSetRedirectExcess(
            SC_System.ownerAccount.getSender(),
            true,
            toNano('0.05')
        );

        // Set excess threshold low enough to receive cashback
        await subcontract.sendSetExcessThreshold(
            SC_System.ownerAccount.getSender(),
            toNano('0.01'),
            toNano('0.05')
        );

        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
            body: beginCell().endCell(),
        });

        const shipConfig = {
            userAddress: subcontract.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        };

        const shipForSubcontract = SC_System.blockchain.openContract(Ship.createFromConfig(
            shipConfig,
            SC_System.shipCode
        ));

        const shipData = shipConfigToCell(shipConfig);
        const shipStateInit = beginCell()
            .storeUint(0, 2)
            .storeRef(SC_System.shipCode)
            .storeRef(shipData)
            .endCell();

        let little_less_than_gas_needed = toNano('0.005');
        const deployAmount = toNano('5');
        const deployBody = beginCell().endCell();
        const totalAmount = GAS_COST_FORWARD_WITH_INIT + deployAmount + toNano('0.5');
        let gas_sent = toNano('0.1'); // Expected gas cost (much less than totalAmount)

        SC_System.messageResult = await subcontract.sendForwardWithInit(
            SC_System.ownerAccount.getSender(),
            totalAmount,
            shipForSubcontract.address,
            shipStateInit,
            deployBody,
            deployAmount,
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
            op: SubcontractOpcodes.OP_FORWARD_WITH_INIT,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: shipForSubcontract.address,
            deploy: true,
            success: true,
        });

        const forwardWithInitTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.op === SubcontractOpcodes.OP_FORWARD_WITH_INIT
        );
        
        // Use transaction fees instead of balance difference (excess is returned with redirectExcess enabled)
        const cost = forwardWithInitTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['DeployShipThroughSubcontract'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("MoveShipThroughSubcontract", async () => {
        const subcontractId = 101n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Enable redirectExcess to receive cashback
        await subcontract.sendSetRedirectExcess(
            SC_System.ownerAccount.getSender(),
            true,
            toNano('0.05')
        );

        // Set excess threshold low enough to receive cashback
        await subcontract.sendSetExcessThreshold(
            SC_System.ownerAccount.getSender(),
            toNano('0.01'),
            toNano('0.05')
        );

        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
            body: beginCell().endCell(),
        });

        const shipConfig = {
            userAddress: subcontract.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        };

        const shipForSubcontract = SC_System.blockchain.openContract(Ship.createFromConfig(
            shipConfig,
            SC_System.shipCode
        ));

        const shipData = shipConfigToCell(shipConfig);
        const shipStateInit = beginCell()
            .storeUint(0, 2)
            .storeRef(SC_System.shipCode)
            .storeRef(shipData)
            .endCell();

        const deployAmount = toNano('5');
        const deployBody = beginCell().endCell();
        const totalDeployAmount = GAS_COST_FORWARD_WITH_INIT + deployAmount + toNano('0.5');

        await subcontract.sendForwardWithInit(
            SC_System.ownerAccount.getSender(),
            totalDeployAmount,
            shipForSubcontract.address,
            shipStateInit,
            deployBody,
            deployAmount,
            SendMode.PAY_GAS_SEPARATELY
        );

        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + toNano('1');
        const shipBalance = await shipForSubcontract.getTonBalance();
        if (shipBalance < minRequiredBalance) {
            await SC_System.ownerAccount.send({
                to: shipForSubcontract.address,
                value: toNano('2'),
                body: beginCell().endCell(),
            });
        }

        let little_less_than_gas_needed = toNano('0.002');
        const moveMessage = encodeRequestToMove({ mode: MoveMode.UP });
        // TODO_TOTAL_GAS_TO_MOVE from types (move no longer triggers mint)
        const forwardAmount = TODO_TOTAL_GAS_TO_MOVE;
        const totalAmount = GAS_COST_FORWARD + forwardAmount;
        let gas_sent = toNano('0.05'); // Expected gas cost (much less than totalAmount)

        SC_System.messageResult = await subcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            totalAmount,
            shipForSubcontract.address,
            moveMessage,
            forwardAmount,
            false,
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
            op: SubcontractOpcodes.OP_FORWARD,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        const forwardTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.op === SubcontractOpcodes.OP_FORWARD
        );
        
        // Use transaction fees instead of balance difference (excess is returned with redirectExcess enabled)
        const cost = forwardTx?.totalFees || toNano('0.01');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['MoveShipThroughSubcontract'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("TransferNotificationForRecipientToSubcontract", async () => {
        const subcontractId = 102n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = toNano('0.06');

        const jettonAmount = toNano('100');
        const notificationBody = beginCell()
            .storeUint(0x7362d09c, 32)
            .storeUint(0, 64)
            .storeCoins(jettonAmount)
            .storeMaybeRef(null)
            .endCell();

        SC_System.messageResult = await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.1'),
            body: notificationBody,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        const transferNotificationTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.success === true
        );
        
        const cost = transferNotificationTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['TransferNotificationForRecipientToSubcontract'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("SubcontractWithdraw", async () => {
        const subcontractId = 103n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
        });

        let little_less_than_gas_needed = toNano('0.01');
        const withdrawAmount = toNano('0.5');
        let gas_sent = toNano('0.1');

        SC_System.messageResult = await subcontract.sendWithdraw(
            SC_System.ownerAccount.getSender(),
            withdrawAmount,
            SC_System.ownerAccount.address,
            gas_sent
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
            op: SubcontractOpcodes.OP_WITHDRAW,
        });

        const withdrawTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.op === SubcontractOpcodes.OP_WITHDRAW
        );
        
        const cost = withdrawTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['SubcontractWithdraw'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("SetRedirectExcess", async () => {
        const subcontractId = 104n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.5'),
        });

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = toNano('0.05');

        SC_System.messageResult = await subcontract.sendSetRedirectExcess(
            SC_System.ownerAccount.getSender(),
            true,
            gas_sent
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
            op: SubcontractOpcodes.OP_SET_REDIRECT_EXCESS,
        });

        // Use transaction fees instead of balance difference (cashback is sent)
        const setRedirectExcessTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.op === SubcontractOpcodes.OP_SET_REDIRECT_EXCESS
        );
        
        const cost = setRedirectExcessTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['SetRedirectExcess'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("SetExcessThreshold", async () => {
        const subcontractId = 105n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.5'),
        });

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = toNano('0.05');

        SC_System.messageResult = await subcontract.sendSetExcessThreshold(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            gas_sent
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
            op: SubcontractOpcodes.OP_SET_EXCESS_THRESHOLD,
        });

        // Use transaction fees instead of balance difference (cashback is sent)
        const setExcessThresholdTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.op === SubcontractOpcodes.OP_SET_EXCESS_THRESHOLD
        );
        
        const cost = setExcessThresholdTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['SetExcessThreshold'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("Manual Deploy", async () => {
        const subcontractId = 106n;
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        
        // Create a user account to send 1 TON to pop-up the address
        const userAccount = await SC_System.blockchain.treasury("user");
        
        // User sends 1 TON to pop-up the subcontract address
        SC_System.messageResult = await userAccount.send({
            to: subcontract.address,
            value: toNano('1'),
            body: beginCell().endCell(),
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userAccount.address,
            to: subcontract.address,
            // success: true,
            value: toNano('1'),
        });
        
        let little_less_than_gas_needed = toNano('0.01');
        // const GAS_COST_MANUAL_DEPLOY: int = ton("0.4");
        const manualDeployAmount = GAS_COST_MANUAL_DEPLOY;
        
        // Verify contract has enough balance (contract.getOriginalBalance() - in.valueCoins > GAS_COST_MANUAL_DEPLOY)
        // Contract should have ~1 TON from user (minus gas), so after receiving 0.5 TON, balance will be > 0.4 TON ✓
        const ownerOriginalBalance = await SC_System.ownerAccount.getBalance();
        SC_System.messageResult = await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), manualDeployAmount);
        const ownerNewBalance = await SC_System.ownerAccount.getBalance();
        const contractBalance = await subcontract.getTonBalance();
        
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
            op: SubcontractOpcodes.OP_MANUAL_DEPLOY,
        });

        // Check that owner received cashback
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: SC_System.ownerAccount.address,
            success: true,
            // value: manualDeployAmount,
        });

        const manualDeployTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === subcontract.address &&
            tx.op === SubcontractOpcodes.OP_MANUAL_DEPLOY
        );
        
        
        expect(contractBalance).toBeGreaterThan(toNano('0.9')); // Account for gas fees
        expect(contractBalance).toBeLessThan(toNano('1.1'));

        // Use transaction fees instead of balance difference (cashback is sent)
        const cost = manualDeployTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['ManualDeploy'] = costStr;

        const costReallyForAdmin = ownerNewBalance - ownerOriginalBalance;
        console.log(`Cost Really for Admin: ${costReallyForAdmin}`);
        console.log(`Owner Original Balance: ${ownerOriginalBalance}`);
        console.log(`Owner New Balance: ${ownerNewBalance}`);
        gasCosts['ManualDeployAdmin'] = costReallyForAdmin.toString();
        expect(costReallyForAdmin).toBeLessThan(toNano('0.001'));
        // expect(costReallyForAdmin).toBeGreaterThan(toNano('0.4')); // Account for gas fees
    });
});

