import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";
import { SYNTAX } from "../../shared/syntax";

/** CodeMirror theme from the Doppler tokens (`theme.css`). */
export const yamlTheme = createTheme({
  theme: "dark",
  settings: {
    background: SYNTAX.background,
    foreground: SYNTAX.foreground,
    caret: "#b997ff",
    selection: "#55505b",
    selectionMatch: "#55505b",
    lineHighlight: "#3a3340",
    gutterBackground: SYNTAX.background,
    gutterForeground: "#a5a2a5",
    gutterBorder: "transparent",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  styles: [
    { tag: t.keyword, color: SYNTAX.constant },
    { tag: t.propertyName, color: SYNTAX.key },
    { tag: t.string, color: SYNTAX.string },
    { tag: t.number, color: SYNTAX.constant },
    { tag: t.bool, color: SYNTAX.constant },
    { tag: t.null, color: SYNTAX.constant },
    { tag: t.comment, color: SYNTAX.comment },
  ],
});
