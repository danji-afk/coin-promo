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
  mint: Uint8Array;            // 32-byte mint pubkey
  mintSeed: Uint8Array;        // 32-byte mint keypair seed (must sign the create tx)
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
    tokenMetadata: { uri: opts.uri, name: opts.name, symbol: opts.symbol },
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
  // PumpPortal returns a VersionedTransaction (v0): [compact-u16 sigcount][sig slots (zeros)][message]
  // where message starts with version byte 0x80|v. Sign the message as-is.
  const nSig = buf[0];
  if (nSig < 1 || nSig > 5) throw new Error(`unexpected sigcount byte0=${buf[0]} (len ${buf.length})`);
  const msgStart = 1 + nSig * 64;
  const msg = buf.subarray(msgStart);
  if (!(msg[0] & 0x80)) throw new Error(`expected versioned message (0x80|v), got ${msg[0]}`);
  // sign the message with both keypairs, place sigs in matching slots (slots = zeros otherwise)
  const sigs = [signEd25519(opts.seed, msg), signEd25519(opts.mintSeed, msg)];
  const pubkeys = [opts.pubkey, opts.mint];
  const nAcct = msg[4] | ((msg[5] & 0x7f) << 8); // after version byte: [reqSigs][rdSigned][rdUnsigned][nAccts...]
  // static account keys start after version+3 header bytes + compact nAccts (1 byte for <128)
  const keysStart = 5;
  const slotOf = new Map<number, number>();
  let signerIdx = 0;
  for (let i = 0; i < Math.min(nSig, nAcct); i++) {
    const k = msg.subarray(keysStart + i * 32, keysStart + (i + 1) * 32);
    for (let s = 0; s < pubkeys.length; s++) {
      if (Buffer.from(k).equals(Buffer.from(pubkeys[s]))) slotOf.set(s, signerIdx++);
    }
  }
  const wire = new Uint8Array(1 + nSig * 64 + msg.length);
  wire[0] = nSig;
  for (let s = 0; s < pubkeys.length; s++) {
    const idx = slotOf.get(s);
    if (idx === undefined) throw new Error(`signer ${s} not found among first ${nSig} static accounts`);
    wire.set(sigs[s], 1 + idx * 64);
  }
  wire.set(msg, 1 + nSig * 64);
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
