import type { HighlighterCore, ThemeRegistration } from "shiki/core";
import { SYNTAX } from "../../shared/syntax";

/** The Railway palette as a TextMate theme, matching the editor's (`editor/theme.ts`). */
const THEME: ThemeRegistration = {
  name: "railway",
  type: "dark",
  colors: { "editor.background": SYNTAX.background, "editor.foreground": SYNTAX.foreground },
  tokenColors: [
    { scope: ["entity.name.tag"], settings: { foreground: SYNTAX.key } },
    { scope: ["string"], settings: { foreground: SYNTAX.string } },
    { scope: ["constant.language", "constant.numeric", "keyword"], settings: { foreground: SYNTAX.constant } },
    { scope: ["comment"], settings: { foreground: SYNTAX.comment } },
    { scope: ["punctuation"], settings: { foreground: SYNTAX.punctuation } },
  ],
};

let highlighter: Promise<HighlighterCore> | null = null;

async function get(): Promise<HighlighterCore> {
  return (highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, yaml] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@shikijs/langs/yaml"),
    ]);
    return createHighlighterCore({ langs: [yaml.default], themes: [THEME], engine: createJavaScriptRegexEngine() });
  })());
}

/** Returns HTML for the YAML; falls back to escaped text if shiki fails to load. */
export async function highlightYaml(src: string): Promise<string> {
  try {
    return (await get()).codeToHtml(src, { lang: "yaml", theme: THEME.name! });
  } catch {
    const esc = src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    return `<pre class="shiki"><code>${esc}</code></pre>`;
  }
}
