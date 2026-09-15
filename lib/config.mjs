import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadYaml(relPath) {
  const raw = await readFile(join(ROOT, relPath), 'utf8');
  return yaml.load(raw);
}

export const loadProfile = () => loadYaml('config/profile.yaml');
export const loadBoards = () => loadYaml('config/boards.yaml');
