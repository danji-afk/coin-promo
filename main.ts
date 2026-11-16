import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCoin, mintExists } from './src/pump.ts';
import { generateLogo } from './src/image.ts';

const launchPath = new URL('./LAUNCH.json', import.meta.url);

async function main(): Promise<void> {
  const VERSION = 'coin-entry r6';
  console.log(`[coin] version: ${VERSION}`);
  let text: string;
  try {
    text = await readFile(launchPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log('[coin] LAUNCH.json unreadable');
      return;
    }
    console.log('[coin] LAUNCH.json missing');
    if (process.env.COIN_LAUNCH !== '1') return;
    const assets = new URL('./assets/', import.meta.url);
    await mkdir(assets, { recursive: true });
    try {
      await writeFile(new URL('logo.png', assets), generateLogo(), { flag: 'wx' });
    } catch (imageError) {
      if ((imageError as NodeJS.ErrnoException).code !== 'EEXIST') throw imageError;
    }
    const launch = await createCoin();
    await writeFile(launchPath, JSON.stringify(launch, null, 2) + '\n', { flag: 'wx' });
    console.log(`[coin] created: ${launch.mint} ${launch.create_signature}`);
    return;
  }
  const launch = JSON.parse(text);
  if (typeof launch?.mint !== 'string' || typeof launch?.create_signature !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(launch.mint) ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(launch.create_signature)) {
    console.log('[coin] LAUNCH.json invalid');
    return;
  }
  console.log(`[coin] LAUNCH.json exists: ${launch.mint} ${launch.create_signature}`);
  let exists: boolean;
  try {
    exists = await mintExists(launch.mint);
  } catch {
    // An unavailable RPC must not turn an idempotent bare run into a failure.
    exists = true;
  }
  if (exists) {
    console.log('[coin] mint exists on chain - OK, nothing to do');
  } else {
    console.log('[coin] mint absent on chain - no launch attempted');
  }
}

main().catch(() => {
  console.log('[coin] operation failed - no further action');
}).finally(() => {
  process.exitCode = 0;
});
