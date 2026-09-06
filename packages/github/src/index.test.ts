import {describe,expect,it} from "vitest";
import {checkSummary,verifyWebhookSignature} from "./index.js";
import {createHmac} from "node:crypto";
describe("webhook security",()=>{it("accepts only a valid HMAC",()=>{const body=Buffer.from("hello"),secret="secret",sig=`sha256=${createHmac("sha256",secret).update(body).digest("hex")}`;expect(verifyWebhookSignature(body,sig,secret)).toBe(true);expect(verifyWebhookSignature(body,sig+"0",secret)).toBe(false);});});
describe("check output",()=>{it("includes execution order",()=>{const result:any={jobId:"x",currentPr:1,comparedPullRequests:[2],orders:[{order:[1,2],passed:false,durationMs:2,findings:[]}],contracts:[],rollbacks:[],performance:[]};expect(checkSummary(result)).toContain("#1 → #2");});});
