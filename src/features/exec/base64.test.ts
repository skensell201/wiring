import { describe, expect, it } from "vitest";
import { decodeBytes, encodeText } from "./base64";

describe("base64", () => {
  it("encodes text as UTF-8", () => {
    expect(encodeText("hi\n")).toBe("aGkK");
    expect(new TextDecoder().decode(decodeBytes(encodeText("héllo ✓")))).toBe("héllo ✓");
  });
  it("decodes raw bytes", () => {
    expect([...decodeBytes("G1szMW0=")]).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
  });
});
