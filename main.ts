// makefun-coin-promo-01 entry: launch one pump.fun coin from the linked make.fun wallet.
// DRY-RUN by default (COIN_LAUNCH unset): prints the full plan, validates constants, writes assets/.
// COIN_LAUNCH=1: metadata URI = GitHub raw (public repo), then PumpPortal local trade API
// (sign locally, key never leaves the machine) -> sendTransaction -> confirm -> LAUNCH.json.
// Re-running after launch is a no-op: LAUNCH.json is validated against the chain.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { b58encode } from './src/base58.ts';
import { loadKeypairJson, generateKeypair } from './src/tx.ts';
import { pumpFunCreate, rpc, getRecentBlockhash } from './src/pump.ts';
import { renderLogoPng } from './src/image.ts';

const REQUIRED_LINE = 'make.fun/bounty/makefun-coin-promo-01';
const WEBSITE = 'https://make.fun/bounty/makefun-coin-promo-01';
const RPC = (process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com');

const COIN_NAME = process.env.COIN_NAME ?? '';
const COIN_SYMBOL = process.env.COIN_SYMBOL ?? '';
const COIN_DESC = process.env.COIN_DESC ?? '';
const REPO_RAW_BASE = process.env.METADATA_BASE ?? ''; // e.g. https://raw.githubusercontent.com/danji-afk/coin-promo/main

function fail(msg: string): never {
  console.error('[coin] ' + msg);
  process.exit(1);
}

async function main() {
  const launch = process.env.COIN_LAUNCH === '1';

  // config validation
  if (!COIN_NAME || !COIN_SYMBOL || !COIN_DESC || !REPO_RAW_BASE) {
    fail('set COIN_NAME, COIN_SYMBOL, COIN_DESC, METADATA_BASE');
  }
  if (!COIN_DESC.includes(REQUIRED_LINE)) fail(`COIN_DESC must contain the exact line: ${REQUIRED_LINE}`);

  // idempotency: if LAUNCH.json exists, validate on-chain and exit (no keypair needed)
  if (existsSync('LAUNCH.json')) {
    const L = JSON.parse(readFileSync('LAUNCH.json', 'utf8'));
    console.log('[coin] LAUNCH.json exists:', L.mint, L.create_signature);
    const info = await rpc('getAccountInfo', [L.mint, { encoding: 'base64' }], RPC);
    if (!info?.value) fail('LAUNCH.json mint does not exist on chain');
    console.log('[coin] mint exists on chain — OK, nothing to do');
    return;
  }

  // wallet (only needed to launch)
  const kpBytes = process.env.MAKEFUN_WALLET_JSON
    ? JSON.parse(process.env.MAKEFUN_WALLET_JSON)
    : JSON.parse(readFileSync(new URL('../makefun-keypair.json', import.meta.url), 'utf8'));
  const { seed, pubkey } = loadKeypairJson(kpBytes);
  const walletB58 = b58encode(pubkey);

  mkdirSync('assets', { recursive: true });
  const logo = renderLogoPng(10);
  writeFileSync('assets/logo.png', logo);

  const mintKp = generateKeypair();
  const mintB58 = b58encode(mintKp.pubkey);
  const imageUri = `${REPO_RAW_BASE}/assets/logo.png`;
  const metadataUri = `${REPO_RAW_BASE}/metadata.json`;
  const buySol = Number(process.env.COIN_BUY_SOL ?? 0);
  const priorityFee = Number(process.env.COIN_PRIORITY_FEE ?? 0.0003);
  if (!(priorityFee >= 0 && priorityFee <= 0.01)) fail(`priorityFee out of sane range: ${priorityFee}`);

  const metadata = {
    name: COIN_NAME,
    symbol: COIN_SYMBOL,
    description: COIN_DESC,
    image: imageUri,
    showName: true,
    createdOnPumpfun: true,
    website: WEBSITE,
  };

  console.log('[coin] ===== plan =====');
  console.log('[coin] wallet   :', walletB58);
  console.log('[coin] name     :', COIN_NAME);
  console.log('[coin] symbol   :', COIN_SYMBOL);
  console.log('[coin] desc     :', COIN_DESC.slice(0, 120) + (COIN_DESC.length > 120 ? '…' : ''));
  console.log('[coin] image    :', imageUri, `(${logo.length} bytes png)`);
  console.log('[coin] metadata :', metadataUri);
  console.log('[coin] website  :', WEBSITE);
  console.log('[coin] mint(new):', mintB58);
  console.log('[coin] buy      :', buySol, 'SOL | priorityFee:', priorityFee, 'SOL');
  console.log('[coin] rpc      :', RPC);

  // validate blockhash RPC reachability (works in both modes)
  const bh = await getRecentBlockhash(RPC);
  console.log('[coin] blockhash ok:', b58encode(bh).slice(0, 12) + '…');

  if (!launch) {
    writeFileSync('metadata.json', JSON.stringify(metadata, null, 2));
    console.log('[coin] DRY-RUN: metadata.json written. Estimated cost ≈ 0.0124 SOL total (seen in the wild: priority 0.0003 + create fee + rent ~0.0026 + sig fee 0.000005).');
    console.log('[coin] Next: commit assets/logo.png + metadata.json to the public repo (raw URL must be live BEFORE launch), then run with COIN_LAUNCH=1.');
    return;
  }

  // verify the metadata + image URLs are live before spending
  for (const u of [metadataUri, imageUri]) {
    const r = await fetch(u, { method: 'HEAD' });
    if (!r.ok) fail(`metadata/image URL not live yet: ${u} → HTTP ${r.status}`);
  }
  console.log('[coin] metadata + image are live on GitHub raw ✓');

  const res = await pumpFunCreate({
    seed, pubkey, mint: mintKp.pubkey, mintSeed: mintKp.seed,
    name: COIN_NAME, symbol: COIN_SYMBOL, uri: metadataUri,
    buySol, priorityFee,
    rpcUrl: RPC,
  });
  writeFileSync('LAUNCH.json', JSON.stringify({ mint: res.mint, create_signature: res.signature }, null, 2));
  console.log('[coin] LAUNCHED ✓');
  console.log('[coin] mint:', res.mint);
  console.log('[coin] create_signature:', res.signature);
}

main().catch((e) => { console.error('[coin] fatal:', e?.message ?? e); process.exit(1); });
