import {describe,expect,it} from "vitest";
import {benchmarkCases} from "./cases.js";
describe("benchmark corpus",()=>{it("contains the promised labeled coverage",()=>{expect(benchmarkCases).toHaveLength(40);expect(benchmarkCases.filter((c)=>c.expected==="conflict")).toHaveLength(20);expect(benchmarkCases.filter((c)=>c.expected==="safe")).toHaveLength(20);});});
