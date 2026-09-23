import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";
import { SYNTAX } from "../../shared/syntax";

/** CodeMirror theme from the Railway tokens (`theme.css`). */
export const yamlTheme = createTheme({
  theme: "dark",
  settings: {
    background: SYNTAX.background,
    foreground: SYNTAX.foreground,
    caret: "#a05fcf",
    selection: "#33323e",
    selectionMatch: "#33323e",
    lineHighlight: "#13111c",
    gutterBackground: SYNTAX.background,
    gutterForeground: "#868593",
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
