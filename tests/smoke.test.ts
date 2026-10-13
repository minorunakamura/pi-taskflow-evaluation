import { expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };

test("package metadata declares the Pi resources", () => {
  // shortcut: checks metadata only; add runtime smoke coverage when the extension exists.

  expect(pkg.name).toBe("pi-taskflow-evaluation");
  expect(pkg.type).toBe("module");
  expect(pkg.main).toBe("./src/index.ts");
  expect(pkg.pi).toEqual({
    extensions: ["./src/index.ts"],
    skills: ["./skills"],
  });
});
