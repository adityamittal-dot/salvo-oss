// One-time interactive login. Opens a real (non-headless) browser, you sign in
// by hand — password, 2FA, Google SSO, whatever the site asks — and the
// resulting session is saved to auth/sessions/<site>.json.
//
// Why manual rather than replaying a password on every run: repeated
// programmatic logins are one of the strongest bot signals a site can see, and
// they are what gets accounts flagged. Signing in once as a human and reusing
// the session is both safer and more reliable (it survives 2FA and SSO, which
// scripted login does not).
//
//   node auth/login.mjs wellfound
//   node auth/login.mjs --list
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(HERE, 'sessions');

const SITES = {
  wellfound: {
    url: 'https://wellfound.com/login',
    note: 'Startup/remote roles. Moderate automation sensitivity.',
  },
  yc: {
    url: 'https://www.workatastartup.com/companies',
    note: 'YC Work at a Startup. Requires a YC account (free).',
  },
  simplify: {
    url: 'https://simplify.jobs/auth/login',
    note: 'Internship / new-grad focused.',
  },
  weworkremotely: {
    url: 'https://weworkremotely.com/remote-jobs',
    note: 'Mostly readable without an account.',
  },
};

function usage() {
  console.log('Usage: node auth/login.mjs <site>\n');
  console.log('Available sites:');
  for (const [key, cfg] of Object.entries(SITES)) {
    const saved = existsSync(join(SESSIONS_DIR, `${key}.json`)) ? ' [session saved]' : '';
    console.log(`  ${key.padEnd(16)} ${cfg.note}${saved}`);
  }
  console.log('\nLinkedIn and Indeed are deliberately absent: their automation');
  console.log('detection is aggressive and a ban is typically permanent. Use those');
  console.log('two by hand.');
}

async function main() {
  const site = process.argv[2];
  if (!site || site === '--list' || !SITES[site]) {
    usage();
    process.exit(site && site !== '--list' ? 1 : 0);
  }

  const cfg = SITES[site];
  await mkdir(SESSIONS_DIR, { recursive: true });
  const statePath = join(SESSIONS_DIR, `${site}.json`);

  console.log(`Opening ${cfg.url}`);
  console.log('Sign in in the browser window, then come back here and press Enter.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch((err) => {
    console.warn(`Navigation warning: ${err.message}`);
  });

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  await context.storageState({ path: statePath });
  await browser.close();

  console.log(`\nSession saved to auth/sessions/${site}.json`);
  console.log('That file contains live cookies — it is gitignored. Do not commit or share it.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
