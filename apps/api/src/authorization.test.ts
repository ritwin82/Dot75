import {describe,expect,it} from "vitest";
import {repositoryRole} from "./authorization.js";
describe("repository roles",()=>it("orders GitHub permissions into viewer, maintainer, and admin",()=>{expect(repositoryRole({pull:true})).toBe("viewer");expect(repositoryRole({push:true})).toBe("maintainer");expect(repositoryRole({admin:true})).toBe("admin");expect(repositoryRole(undefined)).toBeUndefined();}));
