import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({remediate:vi.fn(),set:vi.fn(),getJob:vi.fn(),load:vi.fn(),audit:vi.fn(),event:vi.fn()}));
vi.mock("@localmesh/engine",()=>({remediateValidationInput:state.remediate}));
vi.mock("@localmesh/db",()=>({setRemediationAttempt:state.set,getJob:state.getJob,loadReplayInput:state.load,saveAuditEvent:state.audit,appendJobEvent:state.event}));
import {runRemediationJob} from "./remediate-job.js";
describe("queued remediation worker",()=>{
  beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("OLLAMA_MODEL","model");state.getJob.mockResolvedValue({owner:"o",repo:"r"});state.load.mockResolvedValue({version:1});state.remediate.mockResolvedValue({status:"complete",sourceDigest:"d",promptVersion:"1",model:"model",durationMs:1,candidates:[{status:"verified"}]});});
  afterEach(()=>vi.unstubAllEnvs());
  it("persists verified output and an audit event",async()=>{await runRemediationJob({attemptId:"a",jobId:"j",actor:"dana"});expect(state.set).toHaveBeenNthCalledWith(1,"a","running");expect(state.set).toHaveBeenLastCalledWith("a","completed",expect.objectContaining({status:"complete"}));expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({actor:"dana",action:"remediation.completed"}));});
  it("records failure without hiding it from the queue",async()=>{state.load.mockResolvedValue(undefined);await expect(runRemediationJob({attemptId:"a",jobId:"j",actor:"dana"})).rejects.toThrow("replay bundle");expect(state.set).toHaveBeenLastCalledWith("a","failed",undefined,expect.stringContaining("replay bundle"));});
});
