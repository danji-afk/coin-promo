import { b58encode } from './base58.ts';
import { generateKeypair, loadKeypair, signVersionedTransaction, parseVersionedTransaction } from './tx.ts';

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export async function rpc(method: string, params: unknown[], url = process.env.SOLANA_RPC_URL || DEFAULT_RPC): Promise<any> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('RPC HTTP failure');
  const body = await response.json();
  if (body.error || !Object.hasOwn(body, 'result')) throw new Error('RPC response failure');
  return body.result;
}

export async function mintExists(mint: string): Promise<boolean> {
  const result = await rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!result || !Object.hasOwn(result, 'value')) throw new Error('Invalid account response');
  return result.value !== null;
}

export async function createCoin(): Promise<{ mint: string; create_signature: string }> {
  const wallet = await loadKeypair('/root/makefun/makefun-keypair.json');
  const mintKeypair = generateKeypair();
  const mint = b58encode(mintKeypair.publicKey);
  const base = (process.env.REPO_RAW_BASE || 'https://raw.githubusercontent.com/danji-afk/coin-promo/main').replace(/\/+$/, '');
  const response = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: b58encode(wallet.publicKey), action: 'create',
      tokenMetadata: { uri: `${base}/metadata.json`, name: 'Agents Only', symbol: 'AGENTS' },
      mint, denominatedInSol: 'true', amount: 0, slippage: 10, priorityFee: 0.0003, jitoTip: 0,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('PumpPortal create request failed');
  const wire = new Uint8Array(await response.arrayBuffer());
  const parsed = parseVersionedTransaction(wire);
  if (parsed.signerKeys.length !== 2 ||
      !Buffer.from(parsed.signerKeys[0]).equals(Buffer.from(wallet.publicKey)) ||
      !Buffer.from(parsed.signerKeys[1]).equals(Buffer.from(mintKeypair.publicKey))) {
    throw new Error('Unexpected create transaction signers');
  }
  const signed = signVersionedTransaction(wire, [wallet, mintKeypair]);
  const signature = b58encode(parseVersionedTransaction(signed).signatures[0]);
  const submitted = await rpc('sendTransaction', [Buffer.from(signed).toString('base64'), {
    encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  }]);
  if (submitted !== signature) throw new Error('RPC signature mismatch');
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const status = result?.value?.[0];
    if (status?.err) throw new Error('Create transaction failed on chain');
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return { mint, create_signature: signature };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Create confirmation pending: ${mint} ${signature}`);
}
