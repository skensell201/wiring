import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface TermHandle {
  write(data: Uint8Array | string): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  fit(): void;
  readonly cols: number;
  readonly rows: number;
  focus(): void;
  dispose(): void;
}

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function theme(): ITheme {
  return {
    background: css("--color-surface", "#2d2734"),
    foreground: css("--color-text-hi", "#f1f0ec"),
    cursor: css("--color-accent", "#b997ff"),
    selectionBackground: "#b997ff55",
    red: css("--color-status-err", "#ff5632"),
    green: css("--color-status-ok", "#00f575"),
    yellow: css("--color-status-warn", "#ffb547"),
  };
}

export function createTerminal(el: HTMLElement): TermHandle {
  const term = new Terminal({ fontFamily: css("--font-mono", "monospace"), fontSize: 13, scrollback: 5000, cursorBlink: true, macOptionIsMeta: true, theme: theme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // xterm draws its selection itself, so the native Copy cannot see it: ⌘C / Ctrl+Shift+C copy it here.
  term.attachCustomKeyEventHandler((e) => {
    const copy = e.type === "keydown" && e.key.toLowerCase() === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey));
    if (copy && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()); return false; }
    return true;
  });
  fit.fit();
  return {
    write: (data) => term.write(data),
    onData: (cb) => { term.onData(cb); },
    onResize: (cb) => { term.onResize(({ cols, rows }) => cb(cols, rows)); },
    fit: () => fit.fit(),
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
