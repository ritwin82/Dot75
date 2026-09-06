import { describe, expect, it } from "vitest";
import { diffObjects, fingerprintObjects, relationKey } from "./index.js";

describe("catalog normalization", () => {
  const table = { id: "table:public.orders", kind: "table" as const, schema: "public", relation: "orders", name: "orders", definition: "p:r" };
  it("has order-independent fingerprints", () => {
    const col = { id: "column:public.orders.id", kind: "column" as const, schema: "public", relation: "orders", name: "id", definition: "uuid" };
    expect(fingerprintObjects([table,col])).toBe(fingerprintObjects([col,table]));
  });
  it("detects removals and groups relation objects", () => {
    const before = { objects:[table], edges:[], fingerprint:"x" };
    const after = { objects:[], edges:[], fingerprint:"y" };
    expect(diffObjects(before,after)[0]?.definition).toContain("<removed>");
    expect(relationKey(table)).toBe("public.orders");
  });
});
