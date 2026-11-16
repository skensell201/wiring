import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { yamlTheme } from "./theme";

/** The page's Content-Security-Policy nonce, if it has one.
 *
 * Tauri hands the built app a nonce in `style-src` whenever `index.html` carries an inline
 * `<style>`, and a nonce in a directive makes `'unsafe-inline'` ineffective (CSP 3). CodeMirror
 * injects its base theme, its colours and its syntax styles as runtime `<style>` elements, so
 * without the nonce the whole editor would be refused its styles and fall apart. Handing the
 * nonce over keeps the editor styled whichever policy the page runs under. */
function pageNonce(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLElement>("style[nonce]")?.nonce ?? "";
}

const nonce = pageNonce();
const EXTENSIONS = nonce ? [yaml(), EditorView.cspNonce.of(nonce)] : [yaml()];
const SETUP = { lineNumbers: true, foldGutter: false, highlightActiveLine: true, tabSize: 2 };

export interface YamlEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Accessible name of the editor region. */
  label: string;
  readOnly?: boolean;
  autoFocus?: boolean;
}

/** A controlled CodeMirror YAML editor. Loaded lazily (see `LazyYamlEditor`) — CodeMirror is
 *  the largest thing in the bundle and only edit/create ever need it. */
export function YamlEditor({ value, onChange, label, readOnly = false, autoFocus = false }: YamlEditorProps) {
  return (
    <div aria-label={label} role="region" className="selectable h-full min-h-0 text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto [&_.cm-editor.cm-focused]:outline-none">
      <CodeMirror value={value} onChange={onChange} height="100%" theme={yamlTheme} extensions={EXTENSIONS} basicSetup={SETUP}
        indentWithTab readOnly={readOnly} autoFocus={autoFocus} />
    </div>
  );
}

export default YamlEditor;
