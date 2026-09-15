// Re-renders every already-tailored resume from its saved resume.json —
// no Gemini call, so it costs nothing against the free-tier daily quota.
// Use this after any template/font/layout change (like this session's switch
// to real embedded Computer Modern) to bring existing resumes up to date.
//
// Only helps for resumes tailored AFTER resume.json started being saved
// (tailor.mjs, 2026-09-14 onward) — anything generated before that has no
// saved JSON to re-render from and needs a fresh tailor.mjs run instead.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/config.mjs';
import { renderResumePdf, closeBrowser } from './lib/resume-render.mjs';

const GENERATED_DIR = join(ROOT, 'data/generated');

async function main() {
  if (!existsSync(GENERATED_DIR)) {
    console.log('data/generated/ does not exist yet — nothing to re-render.');
    return;
  }
  const dirs = await readdir(GENERATED_DIR);
  let done = 0, skipped = 0;
  for (const d of dirs) {
    const jsonPath = join(GENERATED_DIR, d, 'resume.json');
    if (!existsSync(jsonPath)) {
      skipped++;
      continue;
    }
    const resume = JSON.parse(await readFile(jsonPath, 'utf8'));
    const { pageCount } = await renderResumePdf(resume, join(GENERATED_DIR, d, 'resume.pdf'));
    console.log(`  ${d} (${pageCount} page${pageCount > 1 ? 's' : ''})`);
    done++;
  }
  console.log(`\nRe-rendered ${done}, skipped ${skipped} (no resume.json saved — from before this feature existed).`);
  await closeBrowser();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err.message);
    await closeBrowser();
    process.exit(1);
  });
}
