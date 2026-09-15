// Shared across LLM providers (Gemini, Claude, ...): a model sometimes wraps
// JSON in ```json fences or adds prose around it despite instructions —
// extract the first balanced {...} block rather than assuming the whole
// response is clean JSON.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model output');
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === '{') depth++;
    if (candidate[i] === '}') depth--;
    if (depth === 0) {
      return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('Unbalanced JSON in model output');
}
