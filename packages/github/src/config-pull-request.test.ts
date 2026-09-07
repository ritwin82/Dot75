import {describe,expect,it,vi} from "vitest";
import type {Octokit} from "@octokit/rest";
import {createContractConfigurationPullRequest,previewContractChange} from "./config-pull-request.js";

const base="a".repeat(40);
function client(currentBase=base) {
  const api={
    repos:{
      get:vi.fn(async()=>({data:{default_branch:"main",permissions:{push:true}}})),
      getBranch:vi.fn(async()=>({data:{commit:{sha:currentBase}}})),
      getContent:vi.fn(async()=>{const error=Object.assign(new Error("missing"),{status:404});throw error;}),
      createOrUpdateFileContents:vi.fn(async()=>({data:{}}))
    },
    git:{createRef:vi.fn(async()=>({data:{}}))},
    pulls:{create:vi.fn(async()=>({data:{number:42,html_url:"https://github.example/pr/42"}}))}
  };
  return {api,octokit:api as unknown as Octokit};
}

describe("contract configuration pull requests",()=>{
  it("validates semantic changes",()=>{
    const result=previewContractChange(undefined,"version: 2\nmappings: []\nschema_assertions:\n  - id: users\n    name: Users\n    object: table:public.users\n    exists: true\nsql_assertions: []\n");
    expect(result.summary.schemaAssertions).toEqual({before:0,after:1});
    expect(result.digest).toHaveLength(64);
  });

  it("creates a uniquely named branch and changes only the contracts file",async()=>{
    const {api,octokit}=client();
    const result=await createContractConfigurationPullRequest(octokit,{owner:"team",repo:"app",expectedBaseSha:base,actor:"maintainer",proposedSource:"version: 2\nmappings: []\n"});
    expect(result.number).toBe(42);
    expect(result.branch).toMatch(/^dot75\/contracts-/);
    expect(api.repos.createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({path:".localmesh/contracts.yml",branch:result.branch}));
    expect(api.pulls.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale preview before writing a branch",async()=>{
    const {api,octokit}=client("b".repeat(40));
    await expect(createContractConfigurationPullRequest(octokit,{owner:"team",repo:"app",expectedBaseSha:base,actor:"maintainer",proposedSource:"version: 2\nmappings: []\n"})).rejects.toThrow("default branch changed");
    expect(api.git.createRef).not.toHaveBeenCalled();
  });
});
