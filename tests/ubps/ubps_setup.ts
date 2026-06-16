// SPDX-License-Identifier: UNLICENSED
// Shared setup for the UBPS test suite. UBPS is an INDEPENDENT module (no GM/R*),
// so this is standalone: compile the 5 UBPS codes, deploy the master, hand back
// handles + codes. Each spec compiles once (beforeAll) and inits per test (beforeEach).
import { toNano, Cell } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import { UBPS } from '../../wrappers/ubps/UBPS';

export type UbpsCodes = {
    ubpsCode: Cell;
    unitCode: Cell;
    questionCode: Cell;
    answerCode: Cell;
    beliefSetCode: Cell;
};

export async function compileUbps(): Promise<UbpsCodes> {
    return {
        ubpsCode: await compile('UBPS'),
        unitCode: await compile('UBPSUnit'),
        questionCode: await compile('UBPSQuestion'),
        answerCode: await compile('UBPSAnswer'),
        beliefSetCode: await compile('UBPSBeliefSet'),
    };
}

export type UbpsSystem = {
    blockchain: Blockchain;
    deployer: SandboxContract<TreasuryContract>;
    user: SandboxContract<TreasuryContract>;
    user2: SandboxContract<TreasuryContract>;
    ubps: SandboxContract<UBPS>;
    codes: UbpsCodes;
};

export async function initUbps(codes: UbpsCodes): Promise<UbpsSystem> {
    const blockchain = await Blockchain.create();
    const deployer = await blockchain.treasury('deployer');
    const user = await blockchain.treasury('user');
    const user2 = await blockchain.treasury('user2');
    const ubps = blockchain.openContract(UBPS.createFromConfig({
        ownerAddress: deployer.address,
        unitCode: codes.unitCode,
        questionCode: codes.questionCode,
        answerCode: codes.answerCode,
        beliefSetCode: codes.beliefSetCode,
    }, codes.ubpsCode));
    await ubps.sendDeploy(deployer.getSender(), toNano('0.5'));
    return { blockchain, deployer, user, user2, ubps, codes };
}
