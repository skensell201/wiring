import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { highlightYaml } from "./yaml";

export function YamlTab({ yaml }: { yaml: string }) {
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void highlightYaml(yaml).then((h) => { if (alive) setHtml(h); });
    return () => { alive = false; };
  }, [yaml]);
  if (yaml === "") return <div className="p-4 text-sm text-text-muted">No YAML for this node.</div>;
  return (
    <div className="relative h-full overflow-auto selectable">
      <button type="button" title="Copy YAML" onClick={() => void navigator.clipboard.writeText(yaml)}
        className="absolute right-3 top-3 rounded-md border border-border bg-surface p-1.5 text-text-muted hover:text-text-hi">
        <Copy className="size-4" />
      </button>
      <div className="p-4 font-mono text-xs leading-5 [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
