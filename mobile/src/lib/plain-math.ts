// Older tutor messages wrap plain words in LaTeX delimiters ($yòu$) because
// the prompts once required LaTeX everywhere. The app renders markdown only,
// so unwrap any $…$ / $$…$$ whose content has no LaTeX syntax. TeX's own
// rule (no space just inside the delimiters) keeps prices like "$5 and $10".
const MATH_SPAN = /\$\$([^$]+?)\$\$|\$([^\s$](?:[^$\n]*[^\s$])?)\$/g;
const LATEX_SYNTAX = /[\\^_{}]/;

export function unwrapPlainMath(text: string): string {
  return text.replace(MATH_SPAN, (span, display: string | undefined, inline: string | undefined) => {
    const inner = display ?? inline ?? "";
    return LATEX_SYNTAX.test(inner) ? span : inner;
  });
}
