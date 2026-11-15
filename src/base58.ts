// Solana base58 encode/decode (Bitcoin alphabet), zero-dep.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHA_MAP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) ALPHA_MAP.set(ALPHABET[i], i);

export function b58encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // big number in base256 -> base58 (simple schoolbook)
  const size = Math.ceil(((bytes.length - zeros) * 138) / 100) + 1; // base256 -> base58 grows ~1.38x
  const out: number[] = new Array(size).fill(0);
  let outLen = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < outLen) && k >= 0; k--, j++) {
      carry += 256 * out[k];
      out[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    outLen = j;
  }
  let start = size - outLen;
  while (start < size && out[start] === 0) start++;
  let s = '1'.repeat(zeros);
  for (let k = start; k < size; k++) s += ALPHABET[out[k]];
  return s;
}

export function b58decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const size = Math.ceil(((s.length - zeros) * 733) / 1000) + 1;
  const out: number[] = new Array(size).fill(0);
  let outLen = 0;
  for (let i = zeros; i < s.length; i++) {
    const v = ALPHA_MAP.get(s[i]);
    if (v === undefined) throw new Error(`invalid base58 char: ${s[i]}`);
    let carry = v;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < outLen) && k >= 0; k--, j++) {
      carry += 58 * out[k];
      out[k] = carry % 256;
      carry = (carry / 256) | 0;
    }
    outLen = j;
  }
  let start = size - outLen;
  while (start < size && out[start] === 0) start++;
  const res = new Uint8Array(zeros + (size - start));
  res.fill(0, 0, zeros);
  for (let k = start; k < size; k++) res[zeros + (k - start)] = out[k];
  return res;
}
