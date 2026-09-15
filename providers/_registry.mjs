// Auto-discovers every providers/*.mjs (skipping `_` helpers) and resolves a
// board entry to the provider that claims it. Dropping a file in providers/ is
// enough — there is no manual registration list.
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let cache = null;

export async function loadProviders() {
  if (cache) return cache;
  const files = (await readdir(HERE)).filter(
    (f) => f.endsWith('.mjs') && !f.startsWith('_'),
  );

  const byId = new Map();
  for (const file of files.sort()) {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    const provider = mod.default;
    if (!provider?.id || typeof provider.fetch !== 'function') {
      console.warn(`providers: ${file} has no valid default export, skipping`);
      continue;
    }
    if (byId.has(provider.id)) {
      console.warn(`providers: duplicate id "${provider.id}" in ${file}, skipping`);
      continue;
    }
    byId.set(provider.id, provider);
  }
  cache = byId;
  return byId;
}

// Resolution order mirrors career-ops: an explicit `provider:` field wins,
// otherwise each provider's detect() in alphabetical order, first hit wins.
export async function resolveProvider(entry) {
  const providers = await loadProviders();

  if (entry?.provider) {
    const p = providers.get(entry.provider);
    return p ? { provider: p } : null;
  }

  for (const provider of providers.values()) {
    if (typeof provider.detect !== 'function') continue;
    let hit = null;
    try {
      hit = provider.detect(entry);
    } catch {
      hit = null;
    }
    if (hit) return { provider, ...hit };
  }
  return null;
}
