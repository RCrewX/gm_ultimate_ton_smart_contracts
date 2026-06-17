# gm_ultimate_ton_smart_contracts

> Proprietary — source-available. See [LICENSE](./LICENSE) (All Rights Reserved).

**GM Ultimate** is a system of TON/Tolk smart contracts built on **Blueprint** — not a single game.
The pieces compose into a swappable on-chain platform:

- **GameManager (GM)** — the stable pipe and sole on-chain authority: owner/admin of the **RUDA**
  minter and all subcontracts. GM forwards inbound requests and never embeds game logic.
- **Retranslator (`R*`)** — the swappable *brain* behind GM. Holds the registries and validation
  logic and can be redeployed/upgraded and re-pointed **without recompiling or redeploying GM**.
- **RUDA jetton** — the platform token (TEP-74), minted by GM on behalf of the games.
- **Games** — currently a **race game** (explore a 2D coordinate grid, battle cells, earn RUDA,
  upgrade ships) and a **Soulless Slot Machine** (TryLuck spin → RUDA mint on a 5% win). The race
  game is **one consumer** of the system, not the whole product.
- **Subcontract** — owner relay with the only Ed25519-signed external entrypoint (deploy for users
  without wallets).
- **In-house TEP reference impls** — jetton, nft, sbt, sbtn.

This repository is the **source of truth** for contract opcodes, gas costs, stateInit and
deterministic addresses consumed by downstream apps.

## The race game

One of the games on top of the system. Players control ships that move through coordinate cells,
each with random HP and rewards. Ships explore new cells, battle existing ones, and earn jettons as
rewards. Players upgrade their ships by transferring jettons to the GameManager.

- **Ship Movement**: Navigate through a 2D coordinate grid (X can be negative, Y always positive)
- **Combat System**: Battle cells with HP-based combat mechanics
- **Rewards**: Earn jettons by exploring cells and completing safe exits
- **Ship Upgrades**: Transfer jettons to upgrade ship HP
- **First Explorer Rights**: First player to explore a cell can withdraw accumulated TON and jettons
- **Deterministic Addresses**: Ships, cells, and subcontracts have deterministic addresses for efficient on-demand deployment
- **Subcontract System**: Technical contracts for message redirection, allowing owners to deploy ships for users without wallets

## Project Structure

```
gm_ultimate_ton_smart_contracts/
├── contracts/                 # Tolk smart-contract source
│   ├── ton_race_game/         # game.tolk, ship.tolk, coordinate_cell.tolk (+ static/*)
│   ├── game_manager/          # GameManager — root/admin, owns the RUDA minter
│   ├── soulless_slot_machine/ # TryLuck spin → RUDA mint on a 5% win
│   ├── subcontract/           # owner relay + the only Ed25519-signed external entrypoint
│   └── tep/                   # in-house TEP reference impls: jetton, nft, sbt, sbtn
├── wrappers/                  # TypeScript wrapper classes for contracts
├── compilables/               # *.compile.ts compilation targets
├── tests/                     # Jest + TON Sandbox suite
├── scripts/                   # deployment + utility scripts
├── lib/ · build/              # helpers / compiled artifacts (build is gitignored)
└── deployment_info/           # deployment_latest.json (the published ABI; gitignored)
```

## Prerequisites

- Node.js (v18 or higher)
- npm or pnpm
- TON wallet with testnet/mainnet TON for deployment

## Installation

```bash
# Install dependencies
npm install
# or
pnpm install
```

## Development

### Build Contracts

Compile all Tolk contracts to FunC:

```bash
npm run build
# or
npx blueprint build
```

### Run Tests

Run the test suite using Jest with TON Sandbox:

```bash
npm test
# or
npx blueprint test
```

### Generate Private Key

Generate a new private key for deployment:

```bash
npm run generate-key
# or
ts-node scripts/generatePrivateKey.ts
```

This will:
- Generate a 24-word mnemonic phrase
- Create a private key file (`.privatekey`)
- Display wallet addresses for both V4 and V5 wallets
- Show addresses for both testnet and mainnet

## Deployment

### Setup

1. Generate a private key (see above)
2. Add to `.env` file:
   ```
   PRIVATE_KEY=your_128_hex_character_private_key
   JETTON_CONTENT_URI=https://your-jetton-metadata.json  # Optional
   TON_RPC_ENDPOINT=https://testnet.toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY  # Optional, see Troubleshooting
   ```

   By default the deploy script auto-selects and fails over across a pool of public
   RPC providers. `TON_RPC_ENDPOINT` is an optional override that pins **one** known-good
   endpoint and disables rotation — use it only when the public pool is degraded (see
   [Troubleshooting](#troubleshooting-deployment)). The override URL must carry its own
   auth (the `api_key` goes in the URL).

### Deploy modes (`--mode hard | retro`)

`pnpm deploy` has two strategies, selected with `--mode` (default: **retro**):

| Mode | What it does | When to use |
|------|--------------|-------------|
| **retro** (default) | **Change-detection incremental update.** Compiles every contract, compares each one's **on-chain code hash** to the freshly compiled hash, and acts minimally. | Routine updates of an already-deployed system. |
| **hard** | **Classical full idempotent walk** — deploys any missing contract and seeds all R\* registries. Identical to the pre-`--mode` behavior. | First deploy, a GM change, or a fresh/partial system. |

Retro's decision tree:

- **GameManager changed (or absent)** → **REFUSE.** GM is the stable root and sole on-chain authority; a GM change is a full system migration. Re-run with `--mode hard`.
- **Retranslator (R\*) absent** → **REFUSE** (a hot-swap migrates counters *from* the live R\*; nothing to migrate from). Use `--mode hard`.
- **R\* changed (still live)** → **hot-swap R\***: migrate the mint counters, reseed the registries, repoint GM — then re-register any other changed leaf.
- **Only leaf contracts changed** → redeploy the changed leaves and re-register them on the existing R\* via its setters.

> ⚠ **Orphaning caveat.** Retro redeploys a changed leaf to a NEW deterministic address.
> For **stateful** leaves this STRANDS the child state derived from the old address:
> `ton_race_game` → all ships + coordinate cells; `jettonMinter` → all RUDA wallets +
> balances; `nftPrinter`/`sbtPrinter` → all minted items; `ubps` → all Units/Questions/
> Answers/BeliefSets. (SSM slots are ephemeral → safe.) Retro prints a loud **ORPHAN
> WARNING** per affected contract. On **mainnet** an orphaning redeploy requires `--yes`.
> Always run `--dry-run` first to inspect the plan.

```bash
pnpm deploy:dry:testnet            # print the retro action plan, send NOTHING (read-only)
pnpm deploy:testnet                # retro (incremental) — default
pnpm deploy:testnet:hard           # classical full deploy
pnpm deploy:mainnet:hard           # classical full deploy to mainnet
pnpm deploy:mainnet --yes          # mainnet retro, accept orphaning of stateful leaves
ts-node scripts/deploySystem.ts --help   # full flag reference
```

A standalone R\* hot-swap (independent of a deploy) lives in `scripts/swapRetranslator.ts`
(dry-run by default; `--execute` to swap) — see `scripts/RETRANSLATOR_SWAP_RUNBOOK.md`.

### Deploy to Testnet

```bash
pnpm deploy:testnet
# or
npm run deploy
# or
npx blueprint run deploySystem
# or
clear && pnpm build --all && pnpm blueprint run deploySystem --testnet --mnemonic
```

The deployment script will:
1. Deploy GameManager contract (the stable pipe + on-chain authority)
2. Deploy Retranslator contract and point GameManager at it (`SetRetranslator`)
3. Deploy Game contract
4. Deploy SoullessSlotMachine contract
5. Deploy JettonMinter contract (admin = GameManager)
6. Deploy owner's JettonWallet
7. Deploy owner's Ship
8. Configure the Retranslator registries via `GameManager.RedirectMessage` (jetton info + games info)
9. Mint initial jettons to owner

The script is **idempotent**: re-running it skips any contract that is already deployed
and resumes from where it left off, so it is safe to re-run after a partial deployment.

Deployment information is saved to `deployment_info/deployment_latest.json` (with a
timestamped copy under `deployment_info/all/`) containing all contract addresses. This
file is the published interface that downstream consumers read — see
[Related Projects](#related-projects).

### Deployment Output

The deployment script generates a JSON file with:
- Network (testnet/mainnet)
- Timestamp
- Owner address (bounceable and non-bounceable formats)
- All contract addresses (bounceable and non-bounceable)
- Owner jetton balance
- Deployment status

Example:
```json
{
  "timestamp": "2025-12-13T01:51:41.955Z",
  "network": "testnet",
  "ownerAddress": {
    "bounceable": "kQ...",
    "nonBounceable": "0Q..."
  },
  "gameManager": {
    "bounceable": "kQ...",
    "nonBounceable": "0Q..."
  },
  "retranslator": { ... },
  "game": { ... },
  "jettonMinter": { ... },
  "status": "completed"
}
```

### Troubleshooting deployment

The deploy script talks to the chain through a pool of public RPC providers, auto-selecting
the healthiest and **failing over to the next provider** on each send attempt (up to 6
attempts per transaction). When a send fails, the real RPC reason is printed after the
status code, e.g. `... 500 | RPC: {"ok":false,"error":"..."}`.

**`External message was not accepted: ... configuration parameter 43 is invalid`** (or
mixed `500`/`502` across providers) — this is a **node-side fault, not your contracts or
keys**: the provider's liteserver cannot parse a current network config parameter and so
rejects every external message. It is not specific to your transaction. What to do, in order:

1. **Re-run** `pnpm deploy:testnet`. Failover now tries the whole provider pool (including
   `toncenter_testnet`); providers run different node versions, so a patched one will accept
   the message. The script is idempotent, so a re-run resumes safely.
2. **Pin a known-good endpoint** and re-run, if the public pool stays degraded:
   ```bash
   TON_RPC_ENDPOINT="https://testnet.toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY" pnpm deploy:testnet
   ```
   Get a free testnet key from [@tonapibot](https://t.me/tonapibot). The `api_key` must be in
   the URL; this disables provider rotation and sends only to that endpoint.
3. **If even a pinned/official endpoint returns the same param error**, it is a live testnet
   network incident — no client change can fix a broken liteserver config parse. Wait for the
   providers to upgrade, or point `TON_RPC_ENDPOINT` at your own liteserver/proxy.

## Game Mechanics

### Coordinate System

- **X-axis**: int64 (can be negative, e.g., -10, 0, 10)
- **Y-axis (depth)**: uint64 (always positive, starts at 0)
- **HP**: uint64
- Starting position: (0, 0)

### Movement Modes

- **UP**: Move up (x stays same, y increases by 1)
- **LEFT**: Move left (x decreases by 1, y increases by 1)
- **RIGHT**: Move right (x increases by 1, y increases by 1)
- **EXIT**: Safe exit (x stays same, y increases by 1, triggers safe exit if ship HP > cell HP)

### Combat System

When a ship moves to a cell:
- **First Exploration**: Cell generates a random HP and jetton reward whose magnitude **scales with depth Y** (`generateRandomResult(y)`); outcome tiers EMPTY/LOW/HIGH/EXTRA ≈ 5/45/45/5%
- **Combat Resolution**:
  - If `ship_hp > cell_hp`: Ship continues, HP reduced by cell HP
  - If `ship_hp > cell_hp` + EXIT mode: Safe exit, full reward, ship resets to (0,0)
  - If `ship_hp <= cell_hp`: Ship crashes, 10% reward, ship resets to (0,0)

### Rewards

- **First Explorer**: Receives full `jettonAmount` when first opening a cell
- **Subsequent Explorers**: Receive `jettonAmount / 10` (fixed divisor of ten — NOT `/y`)
- **Safe Exit**: Full accumulated rewards
- **Crash**: 10% of accumulated rewards

### Ship Upgrades

Transfer jettons to GameManager with ship address in forward payload:
1. User transfers jettons from their JettonWallet to GameManager
2. GameManager receives transfer notification
3. HP increase calculated: `generateSpecialRandomUint(jettonAmount, k=3)` floored at 1 → range **[1, 3 × jettonAmount]**
4. Ship HP and max_hp increased by calculated amount

### First Explorer Rights

The first player to explore a cell becomes the "first explorer" and can:
- Withdraw accumulated TON from the cell
- Withdraw accumulated jettons from the cell's jetton wallet

## Contract Architecture

### GameManager
- The stable **pipe** and sole on-chain **authority** (owner/admin of the JettonMinter and all sub-contracts)
- Stores **no** registries/addresses other than its owner and the current Retranslator
- Wraps inbound requests (`R1`, jetton transfer notifications) into `R2` and forwards them to the Retranslator, attesting the initiator
- Emits whatever the Retranslator returns (`R3` → an `R4` send to the recipient); never parses Retranslator payloads
- Owner-only: swap the Retranslator (`SetRetranslator`) and relay config to it (`RedirectMessage`)

### Retranslator
- The swappable **brain** behind GameManager — can be redeployed/upgraded and re-pointed **without recompiling or redeploying GameManager**
- Holds the registries (jetton info, games info, tools info) and the kill-switch / burn-allow flags
- Validates requests (registered game, owner-only burn, GM's own jetton wallet) and computes recipients
- Builds the output bodies (mint, burn, jetton-used) and tells GameManager what to emit; never sends outbound itself

### Game
- Game instance contract
- Manages ship and coordinate cell codes
- Forwards mint requests to GameManager wrapped in `R1` (GameManager relays them to the Retranslator)
- Handles ship upgrade requests originating from the Retranslator (via GameManager)
- Provides address calculation utilities

### Ship
- Player ship contract (one per user)
- Stores user address, game address, and game state
- Handles movement requests from user
- Receives move results from coordinate cells
- Manages HP and accumulated rewards

### CoordinateCell
- Grid cell contract (one per coordinate, deployed on-demand)
- Stores cell HP, jetton reward, and first explorer
- Handles ship movement and combat
- Manages withdrawals for first explorer

### JettonMinter & JettonWallet
- Standard TON jetton implementation
- Used for game rewards and upgrades

### Subcontract
- Technical contract for message redirection
- Created with owner address and unique ID
- Owner can redirect any message to any destination
- Enables deploying ships for users without wallets
- Use case: Owner deploys ships with SubContract(id) as userAddress, then redirects move requests through subcontract to ship

## Testing

The project includes comprehensive tests covering:
- Contract deployment
- Ship movement in all directions
- Combat mechanics (continue, crash, safe exit)
- Ship upgrades via jetton transfers
- Jetton minting and transfers
- Withdrawals (TON and jettons)
- State queries
- Gas consumption
- Address calculations
- Subcontract message redirection

Run specific test files:
```bash
npm test -- ship-movement.spec.ts
npm test -- ship-upgrade.spec.ts
```

## Gas Costs

Estimated gas costs (in TON):
- `GAS_COST_REQUEST_TO_MOVE`: 0.07 TON
- `GAS_COST_REQUEST_SHIP_ADDRESS`: 0.014 TON
- `GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS`: 0.015 TON
- `GAS_COST_SET_JETTON_MINTER_ADDRESS`: 0.02 TON
- `GAS_COST_SET_GAMES`: 0.015 TON
- `GAS_COST_REDIRECT_MESSAGE`: 0.005 TON (GameManager and Subcontract)

## Constants

- `BASIC_SHIP_HP`: 100 (initial ship HP)
- `BASIC_STORAGE_TAX`: 0.01 TON (minimum storage fee)
- `MINT_TON_AMOUNT`: 0.2 TON (TON required for minting jettons)

## Scripts

- `npm run build` - Build all contracts
- `npm test` - Run test suite
- `npm run deploy` - Deploy system to network
- `npm run generate-key` - Generate new private key
- `npm start` - Run blueprint CLI
- `npm run release` - Package and publish (if applicable)

## Blueprint Commands
<!-- pnpm move-ship --testnet --mnemonic -- --exit  -->
<!-- pnpm move-ship --testnet --mnemonic -- --left -->
- `npx blueprint build` - Build contracts
- `npx blueprint test` - Run tests
- `npx blueprint run <script>` - Run deployment script
- `npx blueprint create <ContractName>` - Create new contract template

## Security Considerations

- Private keys should never be committed to version control
- Use `.env` file for sensitive configuration (add to `.gitignore`)
- Test thoroughly on testnet before mainnet deployment
- Review gas costs and ensure sufficient balance
- Verify contract addresses after deployment

## Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests for new features
4. Ensure all tests pass
5. Submit a pull request

## License

**Proprietary — All Rights Reserved.** Copyright (c) 2026 RCrewX. This repository is made
source-available for inspection only; no rights to use, copy, modify, or distribute are granted.
See [LICENSE](./LICENSE). (The deployed contracts are independently readable on-chain.)

## Support

For issues and questions:
- Check existing test files for usage examples
- Review contract source code in `contracts/`
- Check deployment JSON files in `build/` for address formats

## Related Projects

- **ultimate_amusement_park (uap)**: the consumer app. It reads this repo's published
  `deployment_info/deployment_latest.json` at boot for contract addresses + ABI. The seam is the
  artifact, not the repo path.
