/** Railway syntax colours, shared by the CodeMirror editor (`editor/theme.ts`) and the
 *  shiki-highlighted read-only view (`details/yaml.ts`) so both look the same. Kept apart from
 *  either so importing it pulls in neither CodeMirror nor shiki. */
export const SYNTAX = {
  background: "#0d0c14", foreground: "#d0cfd2",
  key: "#bf92ec", string: "#d0cfd2", constant: "#42946e", comment: "#868593", punctuation: "#a1a0ab",
} as const;
