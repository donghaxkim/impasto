import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteCli = process.env.VITE_CLI ?? path.join(projectRoot, 'node_modules/vite/bin/vite.js');
const outputDir = mkdtempSync(path.join(os.tmpdir(), 'impasto-preview-build-'));

try {
  const build = spawnSync(process.execPath, [
    viteCli,
    'build',
    '--config', path.join(projectRoot, 'vite.config.ts'),
    '--outDir', outputDir,
    '--emptyOutDir',
  ], { cwd: projectRoot, encoding: 'utf8' });
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.status !== 0) throw new Error(`Vite build failed with status ${build.status}`);

  let html = readFileSync(path.join(outputDir, 'index.html'), 'utf8');
  const inlineAsset = (tagPattern, tagName, attribute) => {
    html = html.replace(tagPattern, (_tag, assetUrl) => {
      const assetPath = path.join(outputDir, assetUrl.replace(/^\//, ''));
      const content = readFileSync(assetPath, 'utf8');
      return tagName === 'style'
        ? `<style>${content}</style>`
        : `<script type="module">${content}</script>`;
    });
  };

  inlineAsset(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, 'style', 'href');
  inlineAsset(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, 'script', 'src');
  if (/<(?:link rel="stylesheet" crossorigin href|script type="module" crossorigin src)=/.test(html)) {
    throw new Error('Vite output contains an asset tag that was not inlined.');
  }

  writeFileSync(path.join(projectRoot, 'preview.html'), html);
  process.stdout.write(`Wrote ${path.join(projectRoot, 'preview.html')}\n`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
