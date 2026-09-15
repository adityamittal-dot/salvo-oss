// Renders a tailored resume (structured JSON) to an ATS-safe PDF via
// Playwright. ATS-safe means: single column, no tables/text-boxes/images, no
// headers/footers carrying real content, standard section names, real
// selectable text (never an image of text), a standard font.
//
// This is a real constraint, not decoration: most ATS parsers (Workday,
// Greenhouse's resume parser, iCIMS) read a PDF's text layer left-to-right,
// top-to-bottom. A two-column layout gets its lines interleaved into garbage;
// a name/contact block in a header/footer is sometimes dropped entirely.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');

// "Jake's Resume" — the LaTeX template the candidate's actual resume uses,
// among the most widely used CS-resume templates. This is an HTML/CSS port
// of it (structure and the two ATS fixes below are adapted from career-ops'
// templates/cv-template.jake.html), not an attempt to compile real LaTeX:
// there's no public Overleaf compile API to call, and reproducing the layout
// in HTML is both simpler and more portable than standing up a LaTeX
// toolchain for this.
//
// Ligatures disabled (font-variant-ligatures / font-feature-settings):
// headless Chromium can render "fi"/"fl" as a single ligature glyph, and some
// ATS PDF-text-extractors misread it — "verification" comes back
// "veriﬁcation" and silently fails a keyword-required screen. This applies
// regardless of which font is used below.
//
// Font: real Computer Modern (CMU Serif), not a substitute. The candidate's
// actual resume.pdf was inspected directly — decompressing its PDF object
// streams shows it's typeset in genuine Computer Modern (CMR/CMBX/CMTI/CMCSC),
// not just a similar-looking serif — so an approximation was leaving real
// fidelity on the table. Sourced via the "computer-modern" npm package (MIT
// wrapper around the SIL OFL-licensed CMU project, https://cm-unicode.
// sourceforge.io/), embedded as base64 so rendering has no external/file
// dependency. This reverses an earlier design choice that avoided bundled
// fonts over an ATS glyph-advance-spacing concern — that concern is real for
// VARIABLE fonts specifically; these are ordinary static weights, subsetted
// the normal way, and the resulting PDF's extracted text was checked
// directly (not assumed) to confirm no spurious spacing before shipping this.
// CMU Serif has no small-caps weight (rare in free Computer Modern
// distributions), so the name/headline still use synthesized
// font-variant:small-caps — now at least on the correct base letterforms
// instead of Times New Roman's.
let cachedFontFaceCss = null;
async function fontFaceCss() {
  if (cachedFontFaceCss) return cachedFontFaceCss;
  const weights = [
    { file: 'cmu-serif-regular.woff2', weight: 400, style: 'normal' },
    { file: 'cmu-serif-italic.woff2', weight: 400, style: 'italic' },
    { file: 'cmu-serif-bold.woff2', weight: 700, style: 'normal' },
    { file: 'cmu-serif-bolditalic.woff2', weight: 700, style: 'italic' },
  ];
  const blocks = await Promise.all(
    weights.map(async (w) => {
      const data = await readFile(join(FONTS_DIR, w.file));
      const b64 = data.toString('base64');
      return `@font-face { font-family: 'CMU Serif'; font-weight: ${w.weight}; font-style: ${w.style}; src: url(data:font/woff2;base64,${b64}) format('woff2'); }`;
    }),
  );
  cachedFontFaceCss = blocks.join('\n');
  return cachedFontFaceCss;
}

// Fallback stack kept after the embedded font — if it ever fails to load for
// any reason, rendering degrades to the previous safe approximation rather
// than falling back to a generic sans-serif.
const FONT_STACK = "'CMU Serif','Liberation Serif','Times New Roman',Georgia,'DejaVu Serif',serif";

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Literal "– " prefix, not a CSS list marker: the original resume's own PDF
// extracts its bullets as literal "– Engineered..." text, confirming the dash
// is real content in the source, not a decorative glyph. A CSS-generated
// marker (::before content, or list-style-type: "– ") risks not surviving
// into the PDF's text layer the same way native browser bullets don't
// reliably extract as "•" — embedding it as text guarantees it matches.
function bulletList(items) {
  if (!items?.length) return '';
  return `<ul>${items.map((b) => `<li>– ${esc(b)}</li>`).join('')}</ul>`;
}

// Literal uppercase text, not a CSS transform — checked against the actual
// original PDF's extracted text layer, which reads "EDUCATION" as real
// uppercase characters. A CSS text-transform would only change the visual
// rendering, not the underlying extractable text an ATS parser sees.
function section(title, bodyHtml) {
  if (!bodyHtml) return '';
  return `<div class="section"><div class="section-title">${esc(title.toUpperCase())}</div>${bodyHtml}</div>`;
}

// Contact fields that have a real URL render as a clickable label (matching
// the original's "GitHub" / "LinkedIn" link text, not the bare URL) — a
// field with no URL is skipped rather than guessed.
function contactLink(url, label) {
  if (!url) return '';
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}

// `resume` shape: { identity, summary, skills: {category: [items]}, experience: [{company, role, location, dates, bullets}], projects: [{name, stack, dates, bullets}], education: [{school, degree, dates, location}], certifications: [string] }
function toHtml(resume, fontFaces) {
  const { identity } = resume;
  const contactParts = [
    identity.location ? esc(identity.location) : '',
    identity.phone ? `<a href="tel:${esc(identity.phone)}">${esc(identity.phone)}</a>` : '',
    identity.email ? `<a href="mailto:${esc(identity.email)}">${esc(identity.email)}</a>` : '',
    contactLink(identity.github, 'GitHub'),
    contactLink(identity.linkedin, 'LinkedIn'),
  ].filter(Boolean);
  const contactLine = contactParts.join(' <span class="separator">|</span> ');

  const skillsHtml = Object.entries(resume.skills || {})
    .map(([cat, items]) => `<div class="skill-item"><span class="skill-category">${esc(cat)}:</span> ${esc(items.join(', '))}</div>`)
    .join('');

  const expHtml = (resume.experience || [])
    .map(
      (e) => `
      <div class="job">
        <div class="job-header"><span class="job-company">${esc(e.company)}</span><span class="job-period">${esc(e.dates)}</span></div>
        <div class="job-header"><span class="job-role">${esc(e.role)}</span><span class="job-location">${esc(e.location)}</span></div>
        ${bulletList(e.bullets)}
      </div>`,
    )
    .join('');

  // Name | stack | LIVE, all inline on the title row with dates right-aligned
  // — a single-line "Project Name | Node.js, Express.js, ... | Live Demo"
  // format rather than a separate stack line beneath the name. The LIVE
  // segment only appears when the project has a real deployed URL (p.live)
  // — never fabricated, and never shown for a project with none.
  const projHtml = (resume.projects || [])
    .map(
      (p) => `
      <div class="project">
        <div class="job-header">
          <span><span class="project-title">${esc(p.name)}</span> <span class="separator">|</span> <span class="project-stack">${esc(p.stack)}</span>${p.live ? ` <span class="separator">|</span> <a href="${esc(p.live)}">LIVE</a>` : ''}</span>
          <span class="job-period">${esc(p.dates)}</span>
        </div>
        ${bulletList(p.bullets)}
      </div>`,
    )
    .join('');

  const certsHtml = resume.certifications?.length
    ? `<div class="cert-table">${resume.certifications.map((c) => `<div class="cert-item"><span class="cert-title">${esc(c)}</span></div>`).join('')}</div>`
    : '';

  const extracurricularHtml = resume.extracurricular?.length
    ? `<ul class="extracurricular-list">${resume.extracurricular.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '';

  const eduHtml = (resume.education || [])
    .map(
      (ed) => `
      <div class="edu-item">
        <div class="edu-header"><span class="edu-title">${esc(ed.school)}</span><span class="edu-year">${esc(ed.dates)}</span></div>
        <div class="edu-header"><span class="edu-org">${esc(ed.degree)}</span><span class="edu-location">${esc(ed.location)}</span></div>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${fontFaces}
  :root { --page-margin: 0.5in; }
  @page { size: Letter; margin: var(--page-margin); }
  * { box-sizing: border-box; margin: 0; padding: 0; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "dlig" 0; }
  body { font-family: ${FONT_STACK}; font-size: 10.5px; line-height: 1.42; color: #000; background: #fff; }

  /* Name/headline text arrives already Title-Cased ("Aditya Mittal", "Full
     Stack Engineer") — exactly the input font-variant:small-caps needs: the
     capitalized first letter of each word renders full-height, the lowercase
     rest renders as small capitals. No text-transform needed or wanted here. */
  .header { text-align: center; margin-bottom: 9px; }
  .header h1 { font-size: 26px; font-weight: 700; font-variant: small-caps; letter-spacing: 0.03em; line-height: 1.1; margin-bottom: 2px; }
  .headline { font-size: 12px; font-variant: small-caps; letter-spacing: 0.02em; margin-bottom: 3px; }
  .contact-row { font-size: 10px; }
  a { color: #000; text-decoration: underline; }
  .separator { margin: 0 2px; }

  .section { margin-bottom: 8px; }
  /* Plain bold uppercase, NOT small-caps — checked against the original
     resume.pdf's own extracted text layer, which reads literal "EDUCATION",
     "EXPERIENCE" (all-caps characters), not "Education" (small-caps-styled
     title case). Small-caps is real for the name/headline (their extracted
     text is genuinely mixed-case) but not for section headers. */
  .section-title {
    font-size: 12.5px; font-weight: 700; letter-spacing: 0.03em;
    border-bottom: 0.8px solid #000; padding-bottom: 1px; margin-bottom: 4px;
  }

  .job, .project { margin-bottom: 7px; }
  .job:last-child, .project:last-child { margin-bottom: 0; }
  .job-header { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .job-company { font-size: 11px; font-weight: 700; }
  .job-period { font-size: 10.5px; white-space: nowrap; }
  .job-role { font-size: 10.5px; font-style: italic; }
  .job-location { font-size: 10.5px; font-style: italic; text-align: right; }
  /* Hanging indent for the literal "– " bullet prefix: wrapped lines align
     under the bullet text, not under the dash itself. */
  .job ul, .project ul { list-style: none; margin-top: 2px; padding-left: 0; }
  .job li, .project li { margin-bottom: 1.5px; padding-left: 1em; text-indent: -1em; }

  .project-title { font-size: 10.5px; font-weight: 700; }
  .project-stack { font-size: 10.5px; }

  .edu-item { margin-bottom: 4px; }
  .edu-header { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .edu-title { font-weight: 700; }
  .edu-org { font-style: italic; }
  .edu-location { font-size: 10.5px; font-style: italic; }

  .cert-item { margin-bottom: 1.5px; }

  .extracurricular-list { list-style: none; padding-left: 0; }
  .extracurricular-list li { margin-bottom: 1.5px; padding-left: 1em; text-indent: -1em; }

  .skill-item { margin-bottom: 1.5px; }
  .skill-category { font-weight: 700; }

  .header, .edu-item, .cert-item, .skill-item { break-inside: avoid; page-break-inside: avoid; }
  .section-title, .job-company, .job-role, .job-location, .project-title { break-after: avoid; page-break-after: avoid; }
</style></head>
<body>
  <div class="header">
    <h1>${esc(identity.name)}</h1>
    ${resume.summary ? `<div class="headline">${esc(resume.summary)}</div>` : ''}
    <div class="contact-row">${contactLine}</div>
  </div>
  ${section('Education', eduHtml)}
  ${section('Experience', expHtml)}
  ${section('Projects', projHtml)}
  ${section('Technical Skills', skillsHtml)}
  ${section('Extracurricular', extracurricularHtml)}
  ${section('Certifications', certsHtml)}
</body></html>`;
}

let sharedBrowser = null;
async function getBrowser() {
  if (!sharedBrowser) sharedBrowser = await chromium.launch();
  return sharedBrowser;
}

export async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

// Letter page, minus the @page margin in toHtml() (--page-margin: 0.5in, all
// sides — matches Jake's Resume's own margin), converted to CSS px at 96dpi.
// Kept as named constants so they stay in sync if the @page rule above ever
// changes.
//
// Measuring scrollHeight requires the viewport to be constrained to the same
// WIDTH the content will actually wrap at in the printed PDF — page.pdf()
// uses the @page rule for layout, not the viewport, but page.evaluate() runs
// against whatever viewport is currently set (1280px wide by default). Text
// wraps into fewer, longer lines at 1280px than at the true ~7.5in print
// content width, which understates scrollHeight and silently under-detects
// overflow (confirmed: a resume that measured as 1 page rendered as 2).
const PAGE_HEIGHT_IN = 11;
const PAGE_WIDTH_IN = 8.5;
const PAGE_MARGIN_IN = 0.5;
const USABLE_HEIGHT_PX = (PAGE_HEIGHT_IN - 2 * PAGE_MARGIN_IN) * 96;
const CONTENT_WIDTH_PX = Math.round((PAGE_WIDTH_IN - 2 * PAGE_MARGIN_IN) * 96);

export async function renderResumePdf(resume, outPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let pageCount = 1;
  try {
    await page.setViewportSize({ width: CONTENT_WIDTH_PX, height: 200 });
    await page.setContent(toHtml(resume, await fontFaceCss()), { waitUntil: 'load' });
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    pageCount = Math.max(1, Math.ceil(scrollHeight / USABLE_HEIGHT_PX));
    await mkdir(dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath,
      format: 'Letter',
      printBackground: true,
      // No printed header/footer — anything an ATS parser sees repeated on
      // every page (a page-number footer, a running header) risks being read
      // as body content and duplicated or misplaced in the parsed text.
      displayHeaderFooter: false,
    });
  } finally {
    await page.close();
  }
  return { path: outPath, pageCount };
}

export async function renderCoverLetterPdf(text, identity, outPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const paragraphs = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${await fontFaceCss()}
  @page { size: Letter; margin: 0.9in; }
  * { font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "dlig" 0; }
  body { font-family: ${FONT_STACK}; font-size: 11pt; line-height: 1.5; color: #111; margin: 0; }
  .head { margin-bottom: 18px; }
  .head .name { font-size: 13pt; font-weight: 700; }
  p { margin: 0 0 10px 0; }
</style></head>
<body>
  <div class="head">
    <div class="name">${esc(identity.name)}</div>
    <div>${esc(identity.email)} | ${esc(identity.phone || '')}</div>
  </div>
  ${paragraphs}
</body></html>`;
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await mkdir(dirname(outPath), { recursive: true });
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true, displayHeaderFooter: false });
  } finally {
    await page.close();
  }
  return outPath;
}

export async function writeResumeText(resume, outPath) {
  // A plain .txt sibling: some ATS parsers still choke on PDFs from certain
  // renderers, and a text copy is the fallback that always parses cleanly.
  const lines = [];
  lines.push(resume.identity.name);
  lines.push(
    [resume.identity.location, resume.identity.phone, resume.identity.email, resume.identity.github, resume.identity.linkedin]
      .filter(Boolean)
      .join(' | '),
  );
  if (resume.summary) lines.push('', resume.summary);
  for (const [cat, items] of Object.entries(resume.skills || {})) {
    lines.push('', `${cat}: ${items.join(', ')}`);
  }
  if (resume.experience?.length) {
    lines.push('', 'EXPERIENCE');
    for (const e of resume.experience) {
      lines.push(`${e.company} — ${e.role} — ${e.location} — ${e.dates}`);
      for (const b of e.bullets || []) lines.push(`- ${b}`);
    }
  }
  if (resume.projects?.length) {
    lines.push('', 'PROJECTS');
    for (const p of resume.projects) {
      lines.push(`${p.name} — ${p.stack}${p.live ? ` — LIVE: ${p.live}` : ''} — ${p.dates}`);
      for (const b of p.bullets || []) lines.push(`- ${b}`);
    }
  }
  if (resume.education?.length) {
    lines.push('', 'EDUCATION');
    for (const ed of resume.education) lines.push(`${ed.school} — ${ed.degree} — ${ed.dates}`);
  }
  if (resume.extracurricular?.length) {
    lines.push('', 'EXTRACURRICULAR');
    for (const x of resume.extracurricular) lines.push(`- ${x}`);
  }
  if (resume.certifications?.length) {
    lines.push('', 'CERTIFICATIONS');
    for (const c of resume.certifications) lines.push(`- ${c}`);
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, lines.join('\n'));
  return outPath;
}
