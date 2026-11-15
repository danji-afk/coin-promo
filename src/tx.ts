// Raw Solana legacy transaction builder + ed25519 signing via node:crypto. Zero-dep.
import { createHash, createPrivateKey, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { b58encode } from './base58.ts';

export function ed25519KeyFromSeed(seed: Uint8Array) {
  // PKCS8 DER wrapper for an Ed25519 seed: 302e020100300506032b657004220420 || seed
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed),
  ]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return priv;
}

export function signEd25519(seed: Uint8Array, message: Uint8Array): Buffer {
  const priv = ed25519KeyFromSeed(seed);
  return cryptoSign(null, Buffer.from(message), priv); // 64 bytes
}

/** Generate a fresh ed25519 keypair; returns [32-byte seed, 32-byte pubkey]. */
export function generateKeypair(): { seed: Uint8Array; pubkey: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const seed = new Uint8Array(raw.subarray(raw.length - 32));
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
  const pubkey = new Uint8Array(pub.subarray(pub.length - 32));
  return { seed, pubkey };
}

// ---- compact-u16 (Solana "short vec") ----
export function putU16Compact(out: number[], v: number) {
  let x = v;
  for (;;) {
    let byte = x & 0x7f;
    x >>= 7;
    if (x === 0) { out.push(byte); break; }
    byte |= 0x80;
    out.push(byte);
  }
}

export interface AccountMeta { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }
export interface Instruction { programId: Uint8Array; accounts: AccountMeta[]; data: Uint8Array }

export class TransactionBuilder {
  private keys: Uint8Array[] = [];
  private keyIndex = new Map<string, number>();
  private instructions: Instruction[] = [];
  recentBlockhash: Uint8Array | null = null;
  feePayer: Uint8Array | null = null;

  private keyPos(pubkey: Uint8Array, signer: boolean, writable: boolean): number {
    const k = Buffer.from(pubkey).toString('hex');
    let idx = this.keyIndex.get(k);
    if (idx === undefined) {
      idx = this.keys.length;
      this.keys.push(new Uint8Array(pubkey));
      this.keyIndex.set(k, idx);
      return idx;
    }
    // upgrade privileges: signer/writable must appear before readonly unsigned keys.
    // We handle by rebuilding ordering at compile time instead.
    return idx;
  }

  add(programId: Uint8Array, accounts: AccountMeta[], data: Uint8Array) {
    this.instructions.push({ programId: new Uint8Array(programId), accounts, data: new Uint8Array(data) });
  }

  /** Compile a legacy message. Ordering rule: [signers writable..., signers readonly..., others writable..., others readonly...]. */
  compileMessage(): Uint8Array {
    if (!this.recentBlockhash) throw new Error('recentBlockhash missing');
    if (!this.feePayer) throw new Error('feePayer missing');
    // gather all accounts in first-seen order with flags
    interface Entry { pub: Uint8Array; signer: boolean; writable: boolean; first: number }
    const entries: Entry[] = [];
    const map = new Map<string, Entry>();
    const addKey = (pub: Uint8Array, signer: boolean, writable: boolean) => {
      const k = Buffer.from(pub).toString('hex');
      const cur = map.get(k);
      if (cur) { cur.signer = cur.signer || signer; cur.writable = cur.writable || writable; }
      else { const e = { pub: new Uint8Array(pub), signer, writable, first: entries.length }; map.set(k, e); entries.push(e); }
    };
    addKey(this.feePayer, true, true);
    for (const ix of this.instructions) {
      for (const a of ix.accounts) addKey(a.pubkey, a.isSigner, a.isWritable);
      addKey(ix.programId, false, false);
    }
    const signersW = entries.filter((e) => e.signer && e.writable);
    const signersR = entries.filter((e) => e.signer && !e.writable);
    const othersW = entries.filter((e) => !e.signer && e.writable);
    const othersR = entries.filter((e) => !e.signer && !e.writable);
    const ordered = [...signersW, ...signersR, ...othersW, ...othersR];
    const posOf = new Map<string, number>();
    ordered.forEach((e, i) => posOf.set(Buffer.from(e.pub).toString('hex'), i));
    const nSigners = signersW.length + signersR.length;
    const numReadonlySigned = signersR.length;
    const numReadonlyUnsigned = othersR.length;

    const out: number[] = [];
    out.push(nSigners, numReadonlySigned, numReadonlyUnsigned);
    for (const e of ordered) out.push(...e.pub);
    out.push(...this.recentBlockhash);
    putU16Compact(out, this.instructions.length);
    for (const ix of this.instructions) {
      out.push(posOf.get(Buffer.from(ix.programId).toString('hex'))!);
      putU16Compact(out, ix.accounts.length);
      for (const a of ix.accounts) out.push(posOf.get(Buffer.from(a.pubkey).toString('hex'))!);
      putU16Compact(out, ix.data.length);
      out.push(...ix.data);
    }
    return new Uint8Array(out);
  }

  /** Sign with one signer (the feePayer seed) and return the final wire tx. */
  signWith(seed: Uint8Array): Uint8Array {
    const message = this.compileMessage();
    const sig = signEd25519(seed, message);
    const out = new Uint8Array(1 + 64 + message.length);
    out[0] = 1; // one signature
    out.set(sig, 1);
    out.set(message, 65);
    return out;
  }
}

export function sha256b(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data as Buffer).digest();
}

/** Solana findProgramAddress: sha256(seeds || programId || "ProgramDerivedAddress"), must be off-curve. */
export function findPda(programId: Uint8Array, seeds: Uint8Array[]): { pubkey: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256b(Buffer.concat([...seeds.map((s) => Buffer.from(s)), Buffer.from([bump]), Buffer.from(programId), Buffer.from('ProgramDerivedAddress')]));
    if (!isOnCurve(h)) return { pubkey: new Uint8Array(h), bump };
  }
  throw new Error('no PDA found');
}

/** Cheap on-curve check for ed25519 compressed point (32-byte y + sign bit). Full check via crypto. */
export function isOnCurve(p: Uint8Array): boolean {
  try {
    // node can't directly import a raw pubkey; do the math check instead.
    // Ed25519: p = y | (sign<<255). Reject if x exists -> on curve. Use bigint arithmetic.
    const yBuf = Buffer.from(p);
    const sign = (yBuf[31] & 0x80) !== 0;
    yBuf[31] &= 0x7f;
    const P = 2n ** 255n - 19n;
    const y = BigInt('0x' + yBuf.toString('hex')) % P;
    if (y === 0n && sign) return true; // degenerate
    const y2 = (y * y) % P;
    // u = y^2 - 1, v = d*y^2 + 1 ; d = -121665/121666
    const d = (121665n * invert(121666n, P)) % P;
    const u = (y2 - 1n + P) % P;
    const v = (d * y2 + 1n) % P;
    // x^2 = u/v ; has solution iff u * v^((P-5)/8) ... use sqrt via exponent check
    const vinv = invert(v, P);
    const x2 = (u * vinv) % P;
    if (x2 === 0n) return true;
    // check quadratic residue: x2^((P-1)/2) == 1
    const exp = (P - 1n) / 2n;
    return modPow(x2, exp, P) === 1n;
  } catch { return false; }
}

function invert(a: bigint, m: bigint): bigint { return modPow(a, m - 2n, m); }
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n, base = b % m, exp = e;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
}

/** Read a solana-keygen JSON keypair file (array of 64 bytes) -> [seed, pubkey]. */
export function loadKeypairJson(bytes: number[]): { seed: Uint8Array; pubkey: Uint8Array } {
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error('keypair JSON must be 64 bytes');
  const seed = new Uint8Array(bytes.slice(0, 32));
  const pubkey = new Uint8Array(bytes.slice(32));
  return { seed, pubkey };
}

export const b58 = b58encode;
