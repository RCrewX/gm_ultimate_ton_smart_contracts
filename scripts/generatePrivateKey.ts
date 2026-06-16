// SPDX-License-Identifier: UNLICENSED
import { mnemonicNew, mnemonicToPrivateKey, keyPairFromSecretKey } from '@ton/crypto';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function readPrivateKeyFromFile(filePath: string): string {
    if (!existsSync(filePath)) {
        throw new Error(`Private key file not found: ${filePath}`);
    }
    
    const fileContent = readFileSync(filePath, 'utf-8');
    
    // Try to find PRIVATE_KEY= line
    const lines = fileContent.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('PRIVATE_KEY=')) {
            const key = trimmed.substring('PRIVATE_KEY='.length).trim();
            if (key.length === 128) { // 64 bytes = 128 hex characters
                return key;
            }
        }
    }
    
    throw new Error('PRIVATE_KEY not found in file or invalid format');
}

function displayAddressFormats(keyPair: { publicKey: Buffer; secretKey: Buffer }, privateKeyHex: string, mnemonic?: string[]) {
    // Create wallets for both V4 and V5
    const walletV4 = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const walletV5 = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    
    // Check which wallet version blueprint uses (defaults to V5R1 when using mnemonic)
    const blueprintWalletVersion = process.env.WALLET_VERSION || 'v5r1';
    const isBlueprintV5 = blueprintWalletVersion === 'v5r1' || blueprintWalletVersion === 'v5';
    
    // Generate all possible address formats
    const addressFormats = {
        v4: {
            testnet: {
                bounceable: walletV4.address.toString({ bounceable: true, urlSafe: true, testOnly: true }),
                nonBounceable: walletV4.address.toString({ bounceable: false, urlSafe: true, testOnly: true })
            },
            mainnet: {
                bounceable: walletV4.address.toString({ bounceable: true, urlSafe: true, testOnly: false }),
                nonBounceable: walletV4.address.toString({ bounceable: false, urlSafe: true, testOnly: false })
            }
        },
        v5: {
            testnet: {
                bounceable: walletV5.address.toString({ bounceable: true, urlSafe: true, testOnly: true }),
                nonBounceable: walletV5.address.toString({ bounceable: false, urlSafe: true, testOnly: true })
            },
            mainnet: {
                bounceable: walletV5.address.toString({ bounceable: true, urlSafe: true, testOnly: false }),
                nonBounceable: walletV5.address.toString({ bounceable: false, urlSafe: true, testOnly: false })
            }
        }
    };
    
    // Print to console
    console.log('\n=== TON Private Key Information ===\n');
    console.log('Private Key (hex):', privateKeyHex);
    
    if (mnemonic) {
        console.log('\nMnemonic (24 words):');
        console.log(mnemonic.join(' '));
    }
    
    // Show the wallet version that blueprint uses first
    if (isBlueprintV5) {
        console.log('\n⚠️  Blueprint uses Wallet V5R1 by default (when using --mnemonic)');
        console.log('\n=== Wallet V5 Addresses (Blueprint Default) ===');
        console.log('\nTestnet:');
        console.log('  Bounceable:   ', addressFormats.v5.testnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v5.testnet.nonBounceable);
        console.log('\nMainnet:');
        console.log('  Bounceable:   ', addressFormats.v5.mainnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v5.mainnet.nonBounceable);
        
        console.log('\n=== Wallet V4 Addresses ===');
        console.log('\nTestnet:');
        console.log('  Bounceable:   ', addressFormats.v4.testnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v4.testnet.nonBounceable);
        console.log('\nMainnet:');
        console.log('  Bounceable:   ', addressFormats.v4.mainnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v4.mainnet.nonBounceable);
    } else {
        console.log('\n⚠️  Blueprint uses Wallet V4R2 (set WALLET_VERSION=v4r2)');
        console.log('\n=== Wallet V4 Addresses (Blueprint Default) ===');
        console.log('\nTestnet:');
        console.log('  Bounceable:   ', addressFormats.v4.testnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v4.testnet.nonBounceable);
        console.log('\nMainnet:');
        console.log('  Bounceable:   ', addressFormats.v4.mainnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v4.mainnet.nonBounceable);
        
        console.log('\n=== Wallet V5 Addresses ===');
        console.log('\nTestnet:');
        console.log('  Bounceable:   ', addressFormats.v5.testnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v5.testnet.nonBounceable);
        console.log('\nMainnet:');
        console.log('  Bounceable:   ', addressFormats.v5.mainnet.bounceable);
        console.log('  Non-bounceable:', addressFormats.v5.mainnet.nonBounceable);
    }
    
    console.log('\n---\n');
    console.log('Add this to your .env file:');
    console.log(`PRIVATE_KEY=${privateKeyHex}`);
    console.log('\n💡 Address Format Guide:');
    console.log('   - Bounceable addresses start with "EQ" (mainnet) or "kQ" (testnet)');
    console.log('   - Non-bounceable addresses start with "UQ" (mainnet) or "0Q" (testnet)');
    console.log('   - Use bounceable addresses for contracts that should reject invalid messages');
    console.log('   - Use non-bounceable addresses for user wallets and external services\n');
}

async function generatePrivateKey() {
    const args = process.argv.slice(2);
    const isOldMode = args.includes('--old');
    
    let keyPair: { publicKey: Buffer; secretKey: Buffer };
    let privateKeyHex: string;
    let mnemonic: string[] | undefined;
    
    if (isOldMode) {
        // Read from existing .privatekey file
        const filePath = join(process.cwd(), '.privatekey');
        console.log('Reading private key from existing file...');
        privateKeyHex = readPrivateKeyFromFile(filePath);
        
        // Convert hex string to Buffer
        const privateKey = Buffer.from(privateKeyHex, 'hex');
        if (privateKey.length !== 64) {
            throw new Error('PRIVATE_KEY must be 128 hex characters (64 bytes)');
        }
        
        // Create key pair from private key
        keyPair = keyPairFromSecretKey(privateKey);
        
        // Try to read mnemonic from file if available
        try {
            const fileContent = readFileSync(filePath, 'utf-8');
            const mnemonicMatch = fileContent.match(/Mnemonic.*?:\s*([^\n]+)/);
            if (mnemonicMatch) {
                mnemonic = mnemonicMatch[1].trim().split(/\s+/);
            }
        } catch (e) {
            // Mnemonic not found, that's okay
        }
        
        displayAddressFormats(keyPair, privateKeyHex, mnemonic);
    } else {
        // Generate a new 24-word mnemonic (standard TON way)
        mnemonic = await mnemonicNew(24);
        
        // Derive the key pair from the mnemonic
        keyPair = await mnemonicToPrivateKey(mnemonic);
        
        // Use the full secret key (64 bytes for Ed25519)
        // This is what keyPairFromSecretKey expects
        privateKeyHex = keyPair.secretKey.toString('hex');
        
        // Create the content to save
        const fileContent = `# TON Private Key
# Generated: ${new Date().toISOString()}
# 
# IMPORTANT: Keep this file secure and never commit it to version control!
# Add this to your .env file as:
# PRIVATE_KEY=${privateKeyHex}
#
# Mnemonic (24 words - keep this secure too!):
# ${mnemonic.join(' ')}

PRIVATE_KEY=${privateKeyHex}
`;

        // Save to .privatekey file in project root
        const filePath = join(process.cwd(), '.privatekey');
        writeFileSync(filePath, fileContent, { mode: 0o600 }); // Read/write for owner only
        
        displayAddressFormats(keyPair, privateKeyHex, mnemonic);
        
        console.log(`\nPrivate key has been saved to: ${filePath}`);
        console.log('⚠️  Keep this file secure and never commit it to version control!');
        console.log('⚠️  The mnemonic phrase can also be used to recover your wallet!');
    }
}

// Run the script
generatePrivateKey().catch((error) => {
    console.error('Error generating private key:', error);
    process.exit(1);
});
