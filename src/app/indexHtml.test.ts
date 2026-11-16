import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";

/** The app's HTML shell. Tauri serves it as the document, so what it carries decides the
 *  Content-Security-Policy the whole app runs under. */
describe("index.html", () => {
  it("carries no inline style or script", () => {
    // Tauri puts a nonce on every inline <style> and adds it to `style-src`. A nonce in a
    // directive makes 'unsafe-inline' ineffective (CSP 3), so the runtime styles CodeMirror
    // injects would be refused and the YAML editor would lose its layout and colours.
    expect(indexHtml).not.toMatch(/<style[\s>]/i);
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
  });

  it("loads the entry point from a file", () => {
    expect(indexHtml).toMatch(/<script[^>]+src=/i);
  });
});
