// Ashby application-form filler. Validated against a real live posting
// (jobs.ashbyhq.com/supabase/.../application) before being written.
//
// Two things confirmed live that shaped this:
//   1. The job posting URL and the application-FORM url are different —
//      the form lives at `<posting-url>/application`, reached from an
//      "Apply for this Job" link on the posting page. Our providers store
//      the posting URL, so this module appends the suffix itself.
//   2. Ashby uses a single "Name" field (not separate first/last), and adds
//      Github/LinkedIn/Passport Country/Country of Residence as first-class
//      fields alongside Name/Email/Resume. Passport Country and Country of
//      Residence are filled from profile — those are plain facts, not
//      judgment calls, unlike the essay questions ("Why do you want to join
//      X?", "Tell us about your remote-work experience...") and the
////     "how did you hear about us" radio group, which are always left blank.
import { findUnansweredFields } from './_shared.mjs';

const APPLICATION_SUFFIX = '/application';

export function applicationUrl(postingUrl) {
  try {
    const u = new URL(postingUrl);
    if (u.pathname.endsWith(APPLICATION_SUFFIX)) return postingUrl;
    u.pathname = u.pathname.replace(/\/$/, '') + APPLICATION_SUFFIX;
    return u.toString();
  } catch {
    return postingUrl;
  }
}

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

async function uploadResume(page, filePath) {
  if (!filePath) return false;
  try {
    const uploadButton = page.getByRole('button', { name: /upload file/i }).first();
    if (!(await uploadButton.count())) return false;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      uploadButton.click(),
    ]);
    await chooser.setFiles(filePath);
    return true;
  } catch (err) {
    console.warn(`    (Resume upload failed: ${err.message.split('\n')[0]})`);
    return false;
  }
}

export async function fill(page, { profile, resumePath }) {
  const id = profile.identity;
  const filled = [];
  // File attach first, text fields last — confirmed on Greenhouse that
  // attaching a file can remount the form and silently wipe previously-typed
  // text fields (see greenhouse.mjs). Not separately re-verified on Ashby,
  // but this order is never worse and costs nothing, so it's the default here too.
  if (await uploadResume(page, resumePath)) filled.push('Resume');
  if (await fillText(page, 'Name', id.name)) filled.push('Name');
  if (await fillText(page, 'Email', id.email)) filled.push('Email');
  if (await fillText(page, 'Github Profile', id.github)) filled.push('Github');
  if (await fillText(page, 'Linkedin', id.linkedin)) filled.push('LinkedIn');
  if (await fillText(page, 'Country of Residence', id.country)) filled.push('Country of Residence');
  if (await fillText(page, 'Passport Country', id.country)) filled.push('Passport Country');

  const needsReview = await findUnansweredFields(page);
  return { filled, needsReview };
}
