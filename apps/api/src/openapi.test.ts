import {describe,expect,it} from "vitest";
import {openApiDocument} from "./openapi.js";
describe("public API contract",()=>it("documents SSE, exports, and reviewed contract publishing",()=>{const document=openApiDocument("https://dot75.local");expect(document.openapi).toBe("3.1.0");expect(document.paths["/api/jobs/{id}/events"].get.description).toContain("text/event-stream");expect(document.paths["/api/repositories/{owner}/{repo}/contracts/pull-request"].post.responses["409"]).toBeDefined();}));
