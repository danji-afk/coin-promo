import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { b58decode } from './base58.ts';

export type Keypair = { privateKey: KeyObject; publicKey: Uint8Array };
export type Instruction = { programIdIndex: number; accountIndexes: number[]; data: Uint8Array };

function compact(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error('Invalid shortvec');
  const result: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    result.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(result);
}

function readCompact(bytes: Uint8Array, cursor: { offset: number }): number {
  let result = 0;
  for (let i = 0; i < 3; i++) {
    if (cursor.offset >= bytes.length) throw new Error('Truncated shortvec');
    const byte = bytes[cursor.offset++];
    result |= (byte & 127) << (7 * i);
    if (!(byte & 128)) {
      if (result > 65535 || (i > 0 && byte === 0)) throw new Error('Invalid shortvec');
      return result;
    }
  }
  throw new Error('Invalid shortvec');
}

function keyBytes(value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? b58decode(value) : value;
  if (bytes.length !== 32) throw new Error('Expected a 32-byte public key or blockhash');
  return Buffer.from(bytes);
}

// Account keys must already be ordered: writable signers, readonly signers,
// writable non-signers, readonly non-signers. No address lookup tables are used.
export function buildVersionedMessage(options: {
  accountKeys: (Uint8Array | string)[];
  recentBlockhash: Uint8Array | string;
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
  instructions: Instruction[];
}): Uint8Array {
  const { accountKeys, numRequiredSignatures: required, numReadonlySignedAccounts: signed,
    numReadonlyUnsignedAccounts: unsigned } = options;
  if (accountKeys.length > 256 || !Number.isInteger(required) || required < 1 || required > 255 ||
      required > accountKeys.length || !Number.isInteger(signed) || signed < 0 || signed >= required ||
      !Number.isInteger(unsigned) || unsigned < 0 || unsigned > accountKeys.length - required) {
    throw new Error('Invalid message header');
  }
  const instructions = options.instructions.map(instruction => {
    for (const index of [instruction.programIdIndex, ...instruction.accountIndexes]) {
      if (!Number.isInteger(index) || index < 0 || index >= accountKeys.length) throw new Error('Invalid account index');
    }
    return Buffer.concat([Buffer.from([instruction.programIdIndex]), compact(instruction.accountIndexes.length),
      Buffer.from(instruction.accountIndexes), compact(instruction.data.length), Buffer.from(instruction.data)]);
  });
  return Buffer.concat([Buffer.from([128, required, signed, unsigned]), compact(accountKeys.length),
    ...accountKeys.map(keyBytes), keyBytes(options.recentBlockhash), compact(instructions.length),
    ...instructions, Buffer.from([0])]);
}

export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)) };
}

export async function loadKeypair(path: string): Promise<Keypair> {
  const bytes: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(bytes) || bytes.length !== 64 ||
      !bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error('Keypair must be a JSON array of 64 bytes');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(bytes.slice(0, 32))]),
    format: 'der', type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (!publicKey.equals(Buffer.from(bytes.slice(32)))) throw new Error('Keypair public key mismatch');
  return { privateKey, publicKey: new Uint8Array(publicKey) };
}

export function parseVersionedTransaction(wire: Uint8Array): {
  message: Uint8Array; signatures: Uint8Array[]; signerKeys: Uint8Array[];
} {
  const cursor = { offset: 0 };
  const count = readCompact(wire, cursor);
  if (count === 0 || count > 255 || cursor.offset + count * 64 >= wire.length) throw new Error('Invalid transaction signatures');
  const signatures = Array.from({ length: count }, () => {
    const signature = wire.slice(cursor.offset, cursor.offset + 64);
    cursor.offset += 64;
    return signature;
  });
  const message = wire.slice(cursor.offset);
  const position = { offset: 0 };
  const first = message[position.offset++];
  if (first & 128) {
    if (first !== 128) throw new Error('Unsupported message version');
  } else {
    position.offset = 0;
  }
  const required = message[position.offset++];
  const readonlySigned = message[position.offset++];
  const readonlyUnsigned = message[position.offset++];
  const keys = readCompact(message, position);
  if (required !== count || keys < count || keys > 256 || readonlySigned >= count ||
      readonlyUnsigned > keys - count || position.offset + keys * 32 + 32 > message.length) {
    throw new Error('Invalid transaction message');
  }
  const signerKeys = Array.from({ length: count }, (_, index) =>
    message.slice(position.offset + index * 32, position.offset + (index + 1) * 32));
  position.offset += keys * 32 + 32;
  const instructions = readCompact(message, position);
  const take = (length: number) => {
    if (position.offset + length > message.length) throw new Error('Truncated message');
    const data = message.subarray(position.offset, position.offset + length);
    position.offset += length;
    return data;
  };
  // Validate the remaining wire structure before any signature is generated.
  const indexes: number[] = [];
  for (let i = 0; i < instructions; i++) {
    indexes.push(take(1)[0]);
    indexes.push(...take(readCompact(message, position)));
    take(readCompact(message, position));
  }
  let totalKeys = keys;
  if (first & 128) {
    const lookups = readCompact(message, position);
    for (let i = 0; i < lookups; i++) {
      take(32);
      const writable = readCompact(message, position);
      take(writable);
      const readonly = readCompact(message, position);
      take(readonly);
      totalKeys += writable + readonly;
    }
  }
  if (totalKeys > 256 || indexes.some(index => index >= totalKeys) || position.offset !== message.length) {
    throw new Error('Invalid message accounts or trailing data');
  }
  return { message, signatures, signerKeys };
}

export function signVersionedTransaction(wire: Uint8Array, keypairs: Keypair[]): Uint8Array {
  const { message, signatures, signerKeys } = parseVersionedTransaction(wire);
  for (const keypair of keypairs) {
    const index = signerKeys.findIndex(key => Buffer.from(key).equals(Buffer.from(keypair.publicKey)));
    if (index < 0) throw new Error('Keypair is not a transaction signer');
    signatures[index] = sign(null, message, keypair.privateKey);
  }
  if (signatures.some(signature => signature.every(byte => byte === 0))) throw new Error('Missing transaction signature');
  return Buffer.concat([compact(signatures.length), ...signatures.map(value => Buffer.from(value)), Buffer.from(message)]);
}
