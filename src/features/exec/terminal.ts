import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { keyAction } from "./keys";

export interface TermHandle {
  write(data: Uint8Array | string): void;
  onData(cb: (data: string) => void): void;
  /** Non-UTF-8 input xterm produces (e.g. some mouse reports), as raw bytes. */
  onBinary(cb: (bytes: Uint8Array) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  /** Ctrl+Shift+Tab: the user wants focus out of the terminal. */
  onLeave(cb: () => void): void;
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
  const leave: Array<() => void> = [];
  term.attachCustomKeyEventHandler((e) => {
    switch (keyAction(e, term.hasSelection())) {
      case "copy": void navigator.clipboard.writeText(term.getSelection()); return false;
      case "leave": e.preventDefault(); leave.forEach((cb) => cb()); return false;
      case "swallow": return false;
      case "pass": return true;
    }
  });
  fit.fit();
  return {
    write: (data) => term.write(data),
    onData: (cb) => { term.onData(cb); },
    // xterm hands binary data as a string of byte-valued chars.
    onBinary: (cb) => { term.onBinary((data) => cb(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))); },
    onResize: (cb) => { term.onResize(({ cols, rows }) => cb(cols, rows)); },
    onLeave: (cb) => { leave.push(cb); },
    fit: () => fit.fit(),
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
