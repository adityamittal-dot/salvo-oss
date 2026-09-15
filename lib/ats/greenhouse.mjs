// Greenhouse application-form filler. Validated against a real live posting
// (job-boards.greenhouse.io/gitlab/jobs/...) before being written — the
// locator patterns below (`getByRole('textbox', { name })`, the filechooser
// idiom for the Attach buttons) are copied from a working manual run, not
// guessed from documentation.
//
// Scope is deliberately narrow: only fields that are exact facts (name,
// email, phone, LinkedIn, resume/cover-letter files) are filled. Every
// custom per-posting question — and there are usually many, often lifted
// verbatim from the JD's own requirements — is left untouched. Answering
// "Do you have practical fluency across the LLM ecosystem?" or "Are you
// currently located in Bangalore?" is a personal, JD-specific judgment call,
// not a fact this tool has any business guessing at.

import { findUnansweredFields } from './_shared.mjs';

async function fillText(page, label, value) {
  if (!value) return false;
  try {
    const field = page.getByRole('textbox', { name: label, exact: false }).first();
    if (!(await field.count())) return false;
    await field.fill(value, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function attachFile(page, groupNameRe, filePath, label) {
  if (!filePath) return false;
  try {
    const group = page.getByRole('group', { name: groupNameRe }).first();
    if (!(await group.count())) return false;
    const attachButton = group.getByRole('button', { name: 'Attach', exact: false }).first();
    if (!(await attachButton.count())) return false;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      attachButton.click(),
    ]);
    await chooser.setFiles(filePath);
    return true;
  } catch (err) {
    console.warn(`    (${label} attach failed: ${err.message.split('\n')[0]})`);
    return false;
  }
}

export async function fill(page, { profile, resumePath, coverLetterPath }) {
  const id = profile.identity;
  const [firstName, ...rest] = (id.name || '').split(' ');
  const lastName = rest.join(' ');

  // Order is load-bearing, not stylistic: confirmed live that attaching a
  // file to the Resume/CV field causes Greenhouse's form to remount and
  // silently WIPE every text field filled before it (First Name/Email/etc.
  // read back as truly empty afterward — not a detection artifact, verified
  // by reading the raw accessibility tree). Attaching first, then filling
  // text last, is the only order that leaves everything intact together.
  const filled = [];
  if (await attachFile(page, /resume/i, resumePath, 'Resume')) filled.push('Resume');
  if (coverLetterPath && (await attachFile(page, /cover letter/i, coverLetterPath, 'Cover Letter'))) {
    filled.push('Cover Letter');
  }
  if (await fillText(page, 'First Name', firstName)) filled.push('First Name');
  if (await fillText(page, 'Last Name', lastName)) filled.push('Last Name');
  if (await fillText(page, 'Email', id.email)) filled.push('Email');
  if (await fillText(page, 'Phone', id.phone)) filled.push('Phone');
  if (await fillText(page, 'LinkedIn Profile', id.linkedin)) filled.push('LinkedIn');

  const needsReview = await findUnansweredFields(page);
  return { filled, needsReview };
}
