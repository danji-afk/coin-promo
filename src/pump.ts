// PumpPortal local trade API + Solana RPC helpers. Zero-dep, node:http(s) via fetch.
import { TransactionBuilder, generateKeypair, signEd25519 } from './tx.ts';
import { b58encode } from './base58.ts';

const PP_LOCAL = 'https://pumpportal.fun/api/trade-local';

export async function rpc(method: string, params: unknown[], rpcUrl: string): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json() as any;
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

export async function getRecentBlockhash(rpcUrl: string): Promise<Uint8Array> {
  const r = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }], rpcUrl);
  const bh = r?.value?.blockhash;
  if (!bh) throw new Error('no blockhash in response');
  // base58 decode via our own: import lazily to avoid cycles is fine — b58decode
  const { b58decode } = await import('./base58.ts');
  return b58decode(bh);
}

/**
 * Ask PumpPortal to build the pump.fun "create" transaction (unsigned), sign locally, send.
 * Returns { mint, signature }.
 */
export async function pumpFunCreate(opts: {
  seed: Uint8Array;            // 32-byte private seed of the funding wallet
  pubkey: Uint8Array;          // matching public key (base58)
  mint: Uint8Array;            // 32-byte mint keypair secret-derived? we pass a fresh generated mint pubkey
  name: string; symbol: string; uri: string;
  buySol: number;              // initial buy in SOL (0 = create only)
  slippage?: number;
  priorityFee?: number;
  rpcUrl: string;
}): Promise<{ mint: string; signature: string; rawLen: number }> {
  const mintB58 = b58encode(opts.mint);
  const payload = {
    publicKey: b58encode(opts.pubkey),
    action: 'create',
    tokenMetadata: { uri: opts.uri, name: opts.name, ticker: opts.symbol },
    mint: mintB58,
    denominatedInSol: 'true',
    amount: opts.buySol,
    slippage: opts.slippage ?? 10,
    priorityFee: opts.priorityFee ?? 0.0003,
    jitoTip: 0,
  };
  const res = await fetch(PP_LOCAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (makefun-agent)' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`trade-local HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // PumpPortal returns a serialized legacy transaction (message-first, no signatures). Detect:
  // a legacy unsigned message starts with numRequiredSignatures (1) — but so may other things.
  // Heuristic: byte0==1 and byte1==0 (nRequired=1, nReadonlySigned=0) → message layout.
  if (buf[0] !== 1 || buf[1] !== 0) {
    throw new Error(`unexpected trade-local response format: first bytes ${buf[0]},${buf[1]} (len ${buf.length})`);
  }
  // Rebuild via our builder: we cannot re-derive PumpPortal's exact message with our compiler,
  // so sign the message AS-IS: signature = ed25519(message), wire = [1][sig][message].
  const sig = signEd25519(opts.seed, buf);
  const wire = new Uint8Array(1 + 64 + buf.length);
  wire[0] = 1;
  wire.set(sig, 1);
  wire.set(buf, 65);
  const b64 = Buffer.from(wire).toString('base64');
  const send = await rpc('sendTransaction', [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }], opts.rpcUrl);
  const signature = typeof send === 'string' ? send : String(send);
  // Poll confirmation
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: false }], opts.rpcUrl);
    const s = st?.value?.[0];
    if (s) {
      if (s.err) throw new Error(`tx failed on-chain: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
        return { mint: mintB58, signature, rawLen: buf.length };
      }
    }
  }
  throw new Error(`tx not confirmed in 60s: sig=${signature}`);
}
