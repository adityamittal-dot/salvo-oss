// Shared "what's still unanswered" detection for ATS handlers.
//
// The naive approach (query combobox elements, read .innerText() /
// aria-label) does NOT work on react-select-style widgets: the actual DOM
// element behind role="combobox" is often a bare, visually-empty <input>
// with no aria-label of its own — the accessible name is computed from
// surrounding DOM structure, the same computation Playwright's own
// getByRole({name}) matching uses internally. Confirmed live: querying
// these inputs directly returned empty/null for every field; ariaSnapshot()
// resolved every name correctly. So detection goes through ariaSnapshot,
// not direct element introspection.
export async function findUnansweredFields(page) {
  const snapshot = await page.locator('body').ariaSnapshot();
  const lines = snapshot.split('\n');

  // Every combobox found is unanswered by construction: no fill() in this
  // project ever touches a combobox/select (that's specifically the class
  // of custom, per-posting, judgment-requiring question this tool refuses
  // to auto-answer). So simply enumerating them is correct, no separate
  // "is it empty" check needed.
  const comboboxNames = [...snapshot.matchAll(/combobox "([^"]+)"/g)].map((m) => m[1]);

  // Radio groups: same logic — never auto-selected, so every one found is
  // something the user still needs to answer. ariaSnapshot doesn't group
  // radios under one name, so report the raw radio option labels; still
  // useful signal even ungrouped.
  const radioNames = [...snapshot.matchAll(/radio "([^"]+)"/g)].map((m) => m[1]);

  // Textboxes are different: fill() DOES populate some of these (name,
  // email, phone, linkedin, github). A textbox only needs reporting if it's
  // still empty after fill() ran, so check each one's actual value.
  const textboxNames = [...new Set([...snapshot.matchAll(/textbox "([^"]+)"/g)].map((m) => m[1]))];
  const emptyTextboxes = [];
  for (const name of textboxNames) {
    try {
      const field = page.getByRole('textbox', { name, exact: true }).first();
      const value = await field.inputValue({ timeout: 1000 }).catch(() => '');
      if (!value.trim()) emptyTextboxes.push(name);
    } catch {
      // couldn't check this one — report it rather than silently drop it
      emptyTextboxes.push(name);
    }
  }

  return [...new Set([...comboboxNames, ...emptyTextboxes, ...radioNames])];
}
