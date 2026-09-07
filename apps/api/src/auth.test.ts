import {describe,expect,it} from "vitest";
import {openSession,sealSession} from "./auth.js";

const secret="a secure local secret that is more than thirty two characters";
describe("encrypted web sessions",()=>{
  it("round trips session data without exposing the token",()=>{
    const sealed=sealSession({login:"dana",accessToken:"github-token"},secret);
    expect(sealed).not.toContain("github-token");
    expect(openSession(sealed,secret)).toEqual({login:"dana",accessToken:"github-token"});
  });
  it("rejects modified and wrong-key cookies",()=>{
    const sealed=sealSession({login:"dana"},secret);
    expect(openSession(`${sealed}x`,secret)).toBeUndefined();
    expect(openSession(sealed,"another secure secret that is definitely thirty two characters")).toBeUndefined();
  });
  it("requires an adequately strong secret",()=>expect(()=>sealSession({},"short")).toThrow("32 characters"));
});
