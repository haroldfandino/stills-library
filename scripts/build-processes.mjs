import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const [entry, outfile] of [
  ['src/main.ts', 'dist/main.cjs'],
  ['src/preload.ts', 'dist/preload.cjs'],
  ['src/cli.ts', 'dist/cli.cjs'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
  });
}
