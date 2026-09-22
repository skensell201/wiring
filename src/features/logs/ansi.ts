import anser from "anser";

export interface Span { text: string; className?: string }

const COLORS: Record<string, string> = {
  black: "ansi-black", red: "ansi-red", green: "ansi-green", yellow: "ansi-yellow",
  blue: "ansi-blue", magenta: "ansi-magenta", cyan: "ansi-cyan", white: "ansi-white",
};

/** Split a log line on SGR escapes into spans with theme colour classes (spec §5 `ansi.ts`).
 *  Only foreground colours and bold survive; everything else is stripped to plain text.
 *  anser names bright colours `ansi-bright-red`; both variants map to the same theme class. */
export function toSpans(text: string): Span[] {
  return anser
    .ansiToJson(text, { json: true, remove_empty: true, use_classes: true })
    .filter((part) => part.content.length > 0)
    .map((part) => {
      const classes: string[] = [];
      // anser implements reverse video by swapping the palette into `fg`/`bg` (and dropping
      // "reverse" from `decorations`); taking that `fg` would paint highlighted text in the dim
      // background colour, so drop it. `isInverted` is set by anser but missing from its types.
      const inverted = (part as { isInverted?: boolean }).isInverted === true;
      const fg = inverted ? undefined : part.fg?.replace(/^ansi-(bright-)?/, "");
      if (fg && COLORS[fg]) classes.push(COLORS[fg]);
      if (part.decorations.includes("bold")) classes.push("ansi-bold");
      return classes.length ? { text: part.content, className: classes.join(" ") } : { text: part.content };
    });
}
