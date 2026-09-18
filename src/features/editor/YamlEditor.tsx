import { yaml } from "@codemirror/lang-yaml";
import CodeMirror from "@uiw/react-codemirror";
import { yamlTheme } from "./theme";

const EXTENSIONS = [yaml()];
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
