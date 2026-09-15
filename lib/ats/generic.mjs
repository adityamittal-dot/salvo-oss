// Fallback for any posting not on a recognized ATS (a company's own custom
// careers page, a link from HN/RemoteOK/SimplifyJobs straight to an
// employer's site). Every such page has a different, unknown form structure
// — attempting to guess field selectors here would be more likely to fill
// the wrong thing than to help. This just opens the page; the user fills it
// by hand with the tailored resume/cover-letter already open in Explorer.
export async function fill() {
  return { filled: [], needsReview: ['no known ATS detected — fill this one out by hand'] };
}
