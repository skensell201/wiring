import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

/** CodeMirror theme from the n8n tokens (`theme.css`), with vesper-ish syntax colours so the
 *  editor matches the shiki-highlighted read-only view. */
export const yamlTheme = createTheme({
  theme: "dark",
  settings: {
    background: "#1b1728",
    foreground: "#d1cece",
    caret: "#fd8925",
    selection: "#2c2834",
    selectionMatch: "#2c2834",
    lineHighlight: "#1a1624",
    gutterBackground: "#1b1728",
    gutterForeground: "#9d9797",
    gutterBorder: "transparent",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  styles: [
    { tag: t.keyword, color: "#fd8925" },
    { tag: t.propertyName, color: "#7dd3fc" },
    { tag: t.string, color: "#99ffe4" },
    { tag: t.number, color: "#fd8925" },
    { tag: t.bool, color: "#fd8925" },
    { tag: t.null, color: "#fd8925" },
    { tag: t.comment, color: "#8b8b8b" },
  ],
});
