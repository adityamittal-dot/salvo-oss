// Tailors a resume + cover letter for ONE job posting, grounded in two truth
// sources: data/resume/resume.md (master resume) and config/portfolio.yaml
// (verified project facts, pulled from the actual repos — not resume
// marketing copy). The model may reorder/rephrase/select from these; it may
// not invent anything not present in them (modes/tailor-resume.md is the
// enforced contract).
//
// Provider is auto-detected from which API key is set — Claude preferred
// when both are present, since Gemini's free tier hit a hard 20-requests/day
// wall in production (see README) while Claude API has no such cap.
//
// Usage:
//   node tailor.mjs --url "<posting url from data/pipeline.json>"
//   node tailor.mjs --company "Foo" --title "Backend Engineer" --jd "raw JD text"
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import 'dotenv/config';
import { ROOT, loadProfile } from './lib/config.mjs';
import * as claudeProvider from './lib/claude.mjs';
import * as geminiProvider from './lib/gemini.mjs';
import { extractJson } from './lib/extract-json.mjs';
import { renderResumePdf, renderCoverLetterPdf, writeResumeText, closeBrowser } from './lib/resume-render.mjs';

function selectProvider() {
  const forced = process.env.TAILOR_PROVIDER;
  if (forced === 'claude') return claudeProvider;
  if (forced === 'gemini') return geminiProvider;
  if (process.env.ANTHROPIC_API_KEY) return claudeProvider;
  if (process.env.GEMINI_API_KEY) return geminiProvider;
  throw new Error('Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set in .env');
}

const GENERATED_DIR = join(ROOT, 'data/generated');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

// Backstop for modes/tailor-resume.md rule 11 (one page). The prompt asks for
// this, but instruction-following isn't 100% reliable across an unsupervised
// batch of 25 — a hard cap in code means a single non-compliant generation
// can't produce a two-page resume for a first-year candidate. Tightened from
// 3/2 to 2/1 bullets once Skills and Extracurricular became fixed-size,
// non-trimmable sections (rules 6-7) rather than content the model could cut.
function enforceOnePageBudget(resume) {
  (resume.experience || []).forEach((exp, i) => {
    const cap = i === 0 ? 2 : 1; // most-recent/most-relevant role gets the most room
    if (exp.bullets?.length > cap) exp.bullets = exp.bullets.slice(0, cap);
  });
  if (resume.projects?.length > 2) resume.projects = resume.projects.slice(0, 2);
  for (const proj of resume.projects || []) {
    if (proj.bullets?.length > 2) proj.bullets = proj.bullets.slice(0, 2);
  }
}

// Re-rendering is free (no Gemini call) — so on overflow, trim progressively
// harder and re-render rather than settle for a two-page resume. Each step
// mutates a clone, never the original parsed.resume, so meta.json / the .txt
// / .json copies still reflect what was actually tailored if this needs
// debugging later.
//
// Order matters: bullets are the most expendable content, so every step cuts
// bullets before touching anything else. Skills is never touched at all — the
// user explicitly wants the full list every time (modes/tailor-resume.md rule
// 6). Extracurricular is cut only as the absolute last resort (rule 7 asks to
// keep every organization, condensed, before ever dropping one), and even
// then only down to one entry, never to zero.
const TRIM_STEPS = [
  (r) => r, // as-is (already passed through enforceOnePageBudget: 2/1 exp bullets, 2 projects @ 2 bullets)
  (r) => ({ ...r, summary: undefined }),
  (r) => ({
    ...r,
    summary: undefined,
    experience: (r.experience || []).map((e) => ({ ...e, bullets: e.bullets?.slice(0, 1) })),
    projects: (r.projects || []).map((p) => ({ ...p, bullets: p.bullets?.slice(0, 1) })),
  }),
  (r) => ({
    ...r,
    summary: undefined,
    experience: (r.experience || []).map((e) => ({ ...e, bullets: e.bullets?.slice(0, 1) })),
    projects: (r.projects || []).slice(0, 1).map((p) => ({ ...p, bullets: p.bullets?.slice(0, 1) })),
  }),
  (r) => ({
    ...r,
    summary: undefined,
    experience: (r.experience || []).map((e) => ({ ...e, bullets: e.bullets?.slice(0, 1) })),
    projects: (r.projects || []).slice(0, 1).map((p) => ({ ...p, bullets: p.bullets?.slice(0, 1) })),
    extracurricular: (r.extracurricular || []).slice(0, 1),
  }),
];

async function renderResumeWithPageBudget(resume, outPath) {
  let last;
  for (const trim of TRIM_STEPS) {
    last = await renderResumePdf(trim(resume), outPath);
    if (last.pageCount <= 1) return last;
  }
  return last; // exhausted trim steps — caller warns, file is still the best attempt
}

// Contact details are exact facts, not something an LLM should "tailor" —
// letting the model generate them risks exactly what it did once already:
// inventing a plausible-looking LinkedIn URL that was never provided anywhere
// (not in .env, profile.yaml, or resume.md). A wrong link on a live
// application is a real cost, not a cosmetic slip. So identity always comes
// from trusted config, and the model's own identity guess is discarded.
function trustedIdentity(profile) {
  const id = profile.identity || {};
  return {
    name: id.name || '',
    location: id.location || '',
    phone: id.phone || '',
    email: id.email || '',
    github: id.github ? `https://github.com/${id.github.replace(/^https?:\/\/github\.com\//, '')}` : '',
    linkedin: id.linkedin || '', // left blank until the real URL is provided — never guessed
  };
}

function slugFor(company, title, url) {
  const hash = createHash('sha1').update(url || `${company}${title}`).digest('hex').slice(0, 8);
  return `${slugify(company)}_${slugify(title)}_${hash}`;
}

async function loadJobByUrl(url) {
  const path = join(ROOT, 'data/pipeline.json');
  if (!existsSync(path)) throw new Error('data/pipeline.json not found — run `npm run scan` first');
  const pipeline = JSON.parse(await readFile(path, 'utf8'));
  const job = pipeline.jobs.find((j) => j.url === url);
  if (!job) throw new Error(`No job with url ${url} in data/pipeline.json`);
  return job;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// Builds the system prompt handed to whichever provider generates the
// tailoring — also reused by manual-tailor.mjs's --show-prompt so a human
// (or a Claude Code session standing in for the API) can generate the same
// JSON contract the API path would, from the same source material and rules.
export async function buildSystemPrompt(job) {
  const resumeMasterPath = join(ROOT, 'data/resume/resume.md');
  if (!existsSync(resumeMasterPath)) {
    throw new Error('data/resume/resume.md not found — this is the master resume tailoring reads from');
  }
  const [masterResume, portfolioRaw, promptTemplate] = await Promise.all([
    readFile(resumeMasterPath, 'utf8'),
    readFile(join(ROOT, 'config/portfolio.yaml'), 'utf8'),
    readFile(join(ROOT, 'modes/tailor-resume.md'), 'utf8'),
  ]);
  const portfolio = yaml.load(portfolioRaw);

  const systemPrompt = [
    promptTemplate,
    '\n## MASTER RESUME (source of truth for identity/education/experience)\n',
    masterResume,
    '\n## PROJECT FACT BANK (source of truth for projects — select 2, prefer priority 1)\n',
    JSON.stringify(portfolio.projects, null, 2),
    `\n## THIS JOB\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || 'unstated'}\n`,
  ].join('\n');

  const jdText = job.description?.slice(0, 12000) || `${job.title} at ${job.company} — no description text was captured; tailor generically to the title and company.`;

  return { systemPrompt, jdText };
}

// Takes an already-generated {resume, coverLetter, keywordReport} object —
// whether it came from an API call (tailorForJob below) or was written
// directly by a Claude Code session standing in for one (manual-tailor.mjs,
// for when API billing isn't available but a Claude subscription already
// covers this conversation) — and produces the full output bundle: PDFs,
// text copies, resume.json, meta.json. No LLM call happens in this function.
export async function finalizeTailoredJob(job, parsed) {
  if (!parsed?.resume || !parsed?.coverLetter) {
    throw new Error('parsed output missing resume or coverLetter field');
  }
  const profile = await loadProfile();
  enforceOnePageBudget(parsed.resume);
  parsed.resume.identity = trustedIdentity(profile);

  const slug = slugFor(job.company, job.title, job.url);
  const dir = join(GENERATED_DIR, slug);
  await mkdir(dir, { recursive: true });

  const resumePdfPath = join(dir, 'resume.pdf');
  const resumeTxtPath = join(dir, 'resume.txt');
  const resumeJsonPath = join(dir, 'resume.json');
  const coverPdfPath = join(dir, 'cover-letter.pdf');
  const coverTextPath = join(dir, 'cover-letter.txt');
  const metaPath = join(dir, 'meta.json');

  const { pageCount } = await renderResumeWithPageBudget(parsed.resume, resumePdfPath);
  await Promise.all([
    writeResumeText(parsed.resume, resumeTxtPath),
    // Persisted so a future template/font change (like this session's switch
    // to real embedded Computer Modern) can re-render every existing resume
    // for free — no new Gemini call, no burning the tight 20/day free quota.
    writeFile(resumeJsonPath, JSON.stringify(parsed.resume, null, 2)),
    writeFile(coverTextPath, parsed.coverLetter),
    renderCoverLetterPdf(parsed.coverLetter, parsed.resume.identity, coverPdfPath),
  ]);

  const meta = {
    url: job.url,
    company: job.company,
    title: job.title,
    slug,
    tailoredAt: new Date().toISOString(),
    resumePdfPath,
    resumeTxtPath,
    resumeJsonPath,
    coverPdfPath,
    coverTextPath,
    pageCount,
    keywordReport: parsed.keywordReport || { matched: [], missing: [] },
    projectsUsed: (parsed.resume.projects || []).map((p) => p.name),
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  if (pageCount > 1) {
    console.warn(`  WARNING: resume still spans ${pageCount} pages after auto-trim — worth a manual look.`);
  }

  const kr = meta.keywordReport;
  console.log(
    `  -> ${dir}\n  ATS keywords matched: ${kr.matched?.length || 0} | missing: ${kr.missing?.length || 0}` +
      (kr.missing?.length ? `\n  Missing (real gaps, not fabricated): ${kr.missing.slice(0, 6).join(', ')}` : ''),
  );

  return meta;
}

// API-based path: calls whichever provider is configured. Used by
// batch-tailor.mjs and by `node tailor.mjs` directly when an API key is set.
export async function tailorForJob(job) {
  const { systemPrompt, jdText } = await buildSystemPrompt(job);

  const provider = selectProvider();
  console.log(`Tailoring for ${job.company} — ${job.title}... (${provider === claudeProvider ? 'Claude' : 'Gemini'})`);
  // generateWithRetry already retries on transport/429/503 errors; this is a
  // separate concern — the model occasionally returns a truncated or
  // malformed JSON body on an otherwise-successful call (non-determinism,
  // not a network fault), so a parse failure gets its own regeneration attempts.
  const PARSE_ATTEMPTS = 3;
  let parsed;
  let lastParseErr;
  for (let attempt = 1; attempt <= PARSE_ATTEMPTS; attempt++) {
    const raw = await provider.generateWithRetry(systemPrompt, jdText);
    try {
      parsed = extractJson(raw);
      if (!parsed.resume || !parsed.coverLetter) {
        throw new Error('missing resume or coverLetter field');
      }
      break;
    } catch (err) {
      lastParseErr = err;
      console.warn(`  malformed model output (attempt ${attempt}/${PARSE_ATTEMPTS}): ${err.message}`);
    }
  }
  if (!parsed) {
    throw new Error(`Model output was unparseable after ${PARSE_ATTEMPTS} attempts: ${lastParseErr.message}`);
  }

  return finalizeTailoredJob(job, parsed);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let job;
  if (args.url) {
    job = await loadJobByUrl(args.url);
  } else if (args.company && args.title) {
    job = { company: args.company, title: args.title, url: args.url || '', description: args.jd || '' };
  } else {
    console.log('Usage: node tailor.mjs --url "<posting url>"');
    console.log('   or: node tailor.mjs --company "Foo" --title "Backend Engineer" --jd "..."');
    process.exit(1);
  }
  await tailorForJob(job);
  await closeBrowser();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err.message);
    await closeBrowser();
    process.exit(1);
  });
}
