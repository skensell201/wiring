import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | null = null;

async function get(): Promise<HighlighterCore> {
  return (highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, yaml, theme] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/themes/vesper"),
    ]);
    return createHighlighterCore({ langs: [yaml.default], themes: [theme.default], engine: createJavaScriptRegexEngine() });
  })());
}

/** Returns HTML for the YAML; falls back to escaped text if shiki fails to load. */
export async function highlightYaml(src: string): Promise<string> {
  try {
    return (await get()).codeToHtml(src, { lang: "yaml", theme: "vesper" });
  } catch {
    const esc = src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    return `<pre class="shiki"><code>${esc}</code></pre>`;
  }
}
