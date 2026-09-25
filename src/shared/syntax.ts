/** Doppler syntax colours, shared by the CodeMirror editor (`editor/theme.ts`) and the
 *  shiki-highlighted read-only view (`details/yaml.ts`) so both look the same. Kept apart from
 *  either so importing it pulls in neither CodeMirror nor shiki. */
export const SYNTAX = {
  background: "#2d2734", foreground: "#d0c9c4",
  key: "#b997ff", string: "#f1f0ec", constant: "#00f575", comment: "#a5a2a5", punctuation: "#a5a2a5",
} as const;
