import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YamlEditor } from "./YamlEditor";

// One real CodeMirror mount; parents mock this component with a textarea.
describe("YamlEditor", () => {
  it("mounts CodeMirror with the value and the label", async () => {
    render(<YamlEditor value={"kind: Pod\nmetadata:\n  name: web-1\n"} onChange={() => {}} label="Manifest" />);
    const editor = await screen.findByLabelText("Manifest");
    expect(editor.querySelector(".cm-editor")).not.toBeNull();
    expect(editor.textContent).toContain("kind: Pod");
    expect(editor.textContent).toContain("name: web-1");
  });
});
