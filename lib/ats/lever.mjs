// Lever application-form filler.
//
// UNVERIFIED — no Lever-sourced posting was in the queue at the time this was
// written, so unlike greenhouse.mjs and ashby.mjs, these locators were not
// checked against a real live form. Based on Lever's well-documented
// standard hosted apply form (jobs.lever.co/{company}/{id}/apply): Full
// Name, Email, Phone, Current Location, Current Company, LinkedIn, Resume/CV
// upload. Every fill is wrapped defensively — a field that doesn't match
// just gets skipped rather than throwing, so a structural surprise here
// degrades to "filled less than expected", not a crash. Re-verify against a
// real Lever posting the first time one actually reaches this code path,
// and update this comment once it has been.
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

async function attachResume(page, filePath) {
  if (!filePath) return false;
  try {
    // Lever's standard form has a visible "Resume/CV" drop zone with a
    // native file input underneath (id="resume-upload-input" historically) —
    // targeting the input directly rather than requiring a filechooser
    // click, since Lever's uploader has, in the past, used a plain <input
    // type=file> rather than a JS-intercepted click.
    const input = page.locator('input[type="file"]').first();
    if (await input.count()) {
      await input.setInputFiles(filePath);
      return true;
    }
  } catch (err) {
    console.warn(`    (Resume attach failed: ${err.message.split('\n')[0]})`);
  }
  return false;
}

export async function fill(page, { profile, resumePath }) {
  const id = profile.identity;
  const filled = [];
  if (await fillText(page, 'Full Name', id.name) || await fillText(page, 'Name', id.name)) filled.push('Name');
  if (await fillText(page, 'Email', id.email)) filled.push('Email');
  if (await fillText(page, 'Phone', id.phone)) filled.push('Phone');
  if (await fillText(page, 'Current location', id.location) || await fillText(page, 'Location', id.location)) {
    filled.push('Location');
  }
  if (await fillText(page, 'LinkedIn', id.linkedin)) filled.push('LinkedIn');
  if (await attachResume(page, resumePath)) filled.push('Resume');

  // No generic "unanswered questions" scan here (unlike Greenhouse/Ashby) —
  // without a real form to test the detection heuristic against, a wrong
  // heuristic would be worse than none. Always tell the user to check by eye.
  return { filled, needsReview: ['(unverified handler — check the whole form by eye)'] };
}
