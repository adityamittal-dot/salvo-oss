# salvo-oss

A zero-auth job discovery, fit-scoring, resume-tailoring, and tracking
pipeline you customize for yourself. It finds postings across dozens of
companies' own ATS boards (no login, no bot-ban risk), ranks them against
your own profile, generates a truthfully-tailored resume + cover letter per
posting, tracks everything in an Excel file, and gives you a local dashboard
to manage it — but it never submits an application for you. You review and
click submit yourself.

**No Claude subscription, no paid API key, and no AI account of any kind is
required to use this end to end.** Discovery, scoring, and tracking
(`scan.mjs`, `tracker.mjs`, the dashboard) are 100% rule-based and run fully
offline. Resume/cover-letter tailoring can go through a billed LLM API
(`batch-tailor.mjs`) if you want the whole day's queue done in one shot, but
`manual-tailor.mjs` gets you the identical output for free — you write the
tailored JSON yourself, or paste the prompt into any free chatbot you already
have access to.

Modelled in part on [career-ops](https://github.com/career-ops-hq/career-ops):
the provider layer, the zero-auth discovery approach, and the
human-clicks-submit rule are all in that spirit. Everything else — the
scoring, the tailoring pipeline, the Excel tracker, and the dashboard — was
built out from there.

## Why this exists

Most "auto-apply" tools either need you to hand over your LinkedIn/Indeed
login (a real ban risk — those platforms run aggressive automation
detection) or they auto-submit applications, including auto-answering
screening questions like "are you authorized to work in \_\_\_?" — a wrong
auto-answer there is a false statement on a real job application, not a
cosmetic bug.

This tool takes a narrower, more honest position:

1. **Zero login for discovery.** Every source is a public API — Greenhouse,
   Ashby, Lever board endpoints, RemoteOK, Remotive, HN "Who is Hiring" — or,
   where a platform explicitly allows it in its own `robots.txt`, a public
   search API (see the `unstop` provider). Nothing here logs into LinkedIn or
   Indeed on your behalf.
2. **Resume tailoring never invents anything.** The tailoring prompt
   (`modes/tailor-resume.md`) can only reorder, re-emphasize, and rephrase
   facts that already exist in your own `data/resume/resume.md` and
   `config/portfolio.yaml`. It cannot add a skill, a number, or a claim that
   isn't already there — the JD only gets to influence what's already true.
3. **You click submit.** `prep-applications.mjs` fills in the exact facts
   (name, email, resume file...) and leaves every judgment-call screening
   question blank for you. Reviewing a batch of pre-filled applications takes
   minutes; a wrong auto-answer can cost you an offer.

## How it works

```
scan.mjs             discover + filter + score postings          (global, remote-first)
scan-india.mjs        └─ example: a second pass with its own location rule (see below)
  ↓ data/pipeline.json / data/pipeline-india.json
manual-tailor.mjs     tailor a resume + cover letter, zero cost, no AI subscription needed
batch-tailor.mjs      ...or the same thing via a billed Claude/Gemini API call (optional)
  ↓ data/generated/<company>_<role>_<hash>/{resume.pdf, cover-letter.pdf, meta.json}
tracker.mjs           merge everything into data/applications.xlsx
webapp/server.mjs     a local dashboard over that same Excel file
prep-applications.mjs open each posting, fill the form, STOP before submit
```

## Quick start

```bash
git clone https://github.com/adityamittal-dot/salvo-oss.git
cd salvo-oss
npm install
npx playwright install chromium     # only needed for the apply step

cp .env.example .env
cp config/profile.example.yaml config/profile.yaml
cp config/portfolio.example.yaml config/portfolio.yaml
cp data/resume/resume.example.md data/resume/resume.md
# now edit those 4 files with your own real details

node verify-boards.mjs              # which sources are currently live
npm run scan                        # discover + filter + score
npm run track                       # write/refresh the Excel tracker
npm run dashboard                   # open http://localhost:4173
```

None of your filled-in config, resume, generated resumes, or tracker file are
committed — they're all gitignored (see `.gitignore`). Only the `.example`
templates are tracked.

## Customizing it for yourself

Everything that makes this *your* search lives in four files, none of which
are tracked in git:

- **`config/profile.yaml`** — target titles, exclusions, location rules, your
  skills, scoring thresholds. This is the single biggest lever on both
  quality and volume — see the comments in `config/profile.example.yaml` for
  real gaps found while building this (title synonyms you'd never think to
  add, seniority markers like "Engineer II" that don't say "senior," non-tech
  internships that leak in on the word "intern" alone).
- **`config/portfolio.yaml`** — verified, specific facts about your projects,
  one per project, tagged and prioritized. The tailoring step selects from
  these, it never invents them.
- **`data/resume/resume.md`** — your actual master resume in Markdown.
- **`.env`** — identity + work-authorization answers (used to fill forms
  honestly) and, optionally, an LLM API key for automated tailoring.
- **`config/boards.yaml`** — which companies/boards get scanned. This ships
  with a seed list of 130+ Greenhouse/Ashby/Lever companies (mostly YC +
  well-known tech) plus a few aggregator feeds — prune the dead ones with
  `node verify-boards.mjs --prune` and add whatever companies you actually
  want to track.

## Resume tailoring, in more detail

Two ways to run it, same output:

- **`npm run manual-tailor -- --url "<posting url>" --show-prompt`** — zero
  API cost, and no AI subscription required at all. Prints the exact prompt
  (rules + your resume + your portfolio facts + the job description); you
  produce the tailored resume JSON — by writing it yourself, or by pasting
  the prompt into any free chatbot you already have access to (a browser
  ChatGPT/Gemini/Claude.ai session, a local model, etc.) — save the result to
  a file, then run `npm run manual-tailor -- --url "<posting url>" --json
  "<path>"` to render the actual PDF. This is the path if you don't want to
  pay for an API or hold any AI subscription.
- **`npm run batch-tailor`** — tailors the whole day's queue via a billed
  Claude or Gemini API call (set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` in
  `.env`). Costs roughly $0.02–0.03/resume on `claude-haiku-4-5`.

**ATS-safe by construction.** The renderer (`lib/resume-render.mjs`) outputs
a single-column PDF with real selectable text, standard section headers, no
tables, no images — the layout most ATS parsers read correctly. It also
extracts the JD's real keyword requirements and reports which ones you
genuinely have evidence for versus real gaps (`keywordReport` in each job's
`meta.json`, surfaced as the `ATS Match` column in the tracker).

**One resume per posting, saved and linked.** Each tailored resume lands in
its own folder under `data/generated/`, and `tracker.mjs` reads every
folder's `meta.json` and adds clickable **Resume** / **Cover Letter** columns
to that posting's row. Status auto-advances from `discovered` to `prepared`
the first time a posting gets a tailored resume — unless you've already set
the status yourself, which always wins.

## The Excel tracker + local dashboard

`data/applications.xlsx` has:

- **Applications** — every posting from the main scan, colour-coded by status
- **Internships** — a filtered view of Applications (internship postings only)
- **India Market** — an example of a second, independent, region-specific
  sheet (see below)
- **Daily Log** — one row per day, so you can see the funnel move over time

**Status and Notes are yours.** Re-running `npm run track` never overwrites
them — it only refreshes score/location/last-seen and adds new postings.

`npm run dashboard` starts a small local server (`webapp/server.mjs`, zero
extra dependencies) that reads and writes that same `applications.xlsx` file
directly — no separate database. It gives you a searchable, sortable table
with inline-editable Status/Notes/Applied-On, one-click resume/cover-letter
opening, and basic analytics (funnel counts, top companies, by-source
breakdown). Close the file in Excel while using it — they'd both lock the
same file otherwise.

## Where the jobs come from

### No account needed — the primary path

Public JSON endpoints. Nothing logs in, so there's no account to ban.

| Source | What it covers |
|---|---|
| **Greenhouse / Ashby / Lever** | Thousands of companies' own career boards, via each company's public board API |
| **RemoteOK / Remotive** | Remote-only aggregators |
| **HN "Who is Hiring"** | Monthly thread, high signal for roles that never reach a job board |
| **Simplify's GitHub lists** | Community-maintained internship/new-grad Markdown lists |
| **Unstop** (`providers/unstop.mjs`) | India-market internships/entry-level jobs, via Unstop's own public search API (its `robots.txt` explicitly allows `/api/public/*`) |

Add companies by dropping a slug into `config/boards.yaml`, then run
`node verify-boards.mjs` to confirm the board is actually live before trusting
it — ATS slugs go stale, and a wrong guess just 404s (`--prune` removes dead
ones automatically).

### Deliberately excluded

**LinkedIn and Indeed.** Both run aggressive automation detection, and a
LinkedIn ban costs you your professional network during an active job search.
Not worth the added volume. Use them manually.

### `scan-india.mjs` — an example of a regional extension

The main `scan.mjs` pipeline is remote-first by design: it hard-excludes
onsite/hybrid postings, because for someone searching globally-remote roles,
"Hybrid, Austin" is not a real opportunity. But if you're also open to
onsite/hybrid roles in your *own* country, that exclusion is exactly wrong —
so `scan-india.mjs` is a second, independent pass with its own location rule
(no remote-only gate) and its own tracked sheet. It's a genuinely working
feature for the Indian market specifically (via the Unstop provider), and
it's also meant as a template: the pattern — same providers, a different
`titleMatches`/location rule, written to its own pipeline file and sheet — is
the way to add your own regional pass for wherever you actually live.

## Credentials

Copy `.env.example` to `.env` and fill it in. `.env`, `auth/sessions/`, your
filled-in `config/profile.yaml`/`config/portfolio.yaml`, and everything under
`data/` are all gitignored.

For any site that needs a login for you to browse it (see `auth/login.mjs`),
prefer that over putting a password in `.env` — it opens a real browser, you
sign in once by hand (2FA/SSO both work), and the session is reused. Password
replay on every run is itself a bot signal; a persisted session is not.

The `WORK_AUTH_*` values in `.env` are what answer screening questions during
form-filling. Set them accurately — they're deliberately never guessed by a
model.

## Fonts

`fonts/` bundles the Computer Modern typeface (via the `computer-modern` npm
package, itself a wrapper around the SIL OFL-licensed CMU project) so
generated PDFs can use an authentic serif font without depending on what's
installed on your system. See `fonts/LICENSE.txt` — the font files are
licensed separately from the rest of this repository (SIL OFL, not MIT).

## Contributing

Issues and PRs welcome — this started as a personal tool and the parts that
generalize well (a new provider, a bug fix in the filter logic, a dashboard
improvement) are exactly the kind of thing worth sharing back. A few things
worth knowing before you dive in:

- `lib/filter.mjs` and `config/profile.example.yaml` have inline comments
  documenting real bugs found the hard way (title-matching gaps, location
  false-positives) — read them before changing that logic, the reasoning is
  usually non-obvious.
- New providers go in `providers/`, one file, exporting `{ id, detect, fetch }`
  — see `providers/_registry.mjs` for how they're auto-discovered, and
  `providers/unstop.mjs` for a recent, fully-worked example including how to
  verify a source respects `robots.txt` before scraping it.
- Please don't add a provider that requires a logged-in session on a platform
  whose ToS bans automation (LinkedIn, Indeed) — that's a deliberate,
  permanent design boundary, not an oversight.

## License

MIT — see `LICENSE`. (The bundled fonts are separately licensed; see above.)
