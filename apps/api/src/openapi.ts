export function openApiDocument(origin:string) {
  return {
    openapi:"3.1.0",info:{title:"Dot75 self-hosted API",version:"0.1.0",description:"Investigation and contract-configuration API. GitHub Checks remain the authoritative merge-decision surface."},
    servers:[{url:origin}],paths:{
      "/health":{get:{operationId:"getHealth",responses:{"200":{description:"Service is ready"}}}},
      "/health/live":{get:{operationId:"getLiveness",responses:{"200":{description:"API process is alive"}}}},
      "/health/ready":{get:{operationId:"getReadiness",responses:{"200":{description:"Database and queue are ready"},"503":{description:"A required dependency is unavailable"}}}},
      "/api/jobs":{get:{operationId:"listValidationJobs",responses:{"200":{description:"Recent validation jobs"}}}},
      "/api/jobs/{id}":{get:{operationId:"getValidationJob",parameters:[{$ref:"#/components/parameters/JobId"}],responses:{"200":{description:"Stored authoritative validation result"},"404":{$ref:"#/components/responses/NotFound"}}}},
      "/api/jobs/{id}/events":{get:{operationId:"streamJobEvents",description:"Use Accept: text/event-stream for SSE or omit it for polling JSON.",parameters:[{$ref:"#/components/parameters/JobId"},{name:"after",in:"query",schema:{type:"integer",minimum:0}}],responses:{"200":{description:"SSE job-stage events or a JSON event page"}}}},
      "/api/jobs/{id}/export/{format}":{get:{operationId:"exportValidationResult",parameters:[{$ref:"#/components/parameters/JobId"},{name:"format",in:"path",required:true,schema:{enum:["json","markdown","sarif","junit"]}}],responses:{"200":{description:"Immutable result rendered in the selected portable format"}}}},
      "/api/jobs/{id}/remediate":{post:{operationId:"createRemediationAttempt",security:[{githubSession:[]}],responses:{"202":{description:"Remediation queued on an isolated worker"}}}},
      "/api/remediations/{id}":{get:{operationId:"getRemediationAttempt",security:[{githubSession:[]}],responses:{"200":{description:"Current attempt state and verified candidates"}}}},
      "/api/repositories/{owner}/{repo}/contracts":{get:{operationId:"getContractConfiguration",security:[{githubSession:[]}],responses:{"200":{description:"Trusted default-branch contract configuration"}}}},
      "/api/repositories/{owner}/{repo}/contracts/preview":{post:{operationId:"previewContractConfiguration",security:[{githubSession:[]}],responses:{"200":{description:"Validated semantic preview bound to a base SHA"}}}},
      "/api/repositories/{owner}/{repo}/contracts/pull-request":{post:{operationId:"createContractConfigurationPullRequest",security:[{githubSession:[]}],responses:{"200":{description:"Configuration pull request created"},"409":{description:"Preview base became stale"}}}}
    },components:{
      securitySchemes:{githubSession:{type:"apiKey",in:"cookie",name:"dot75_session"}},
      parameters:{JobId:{name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}}},
      responses:{NotFound:{description:"Resource not found"}},
      schemas:{JobEvent:{type:"object",required:["id","jobId","stage","state","message","createdAt"],properties:{id:{type:"integer"},jobId:{type:"string",format:"uuid"},stage:{enum:["discovery","baseline","standalone","relationships","contracts","rollback","reporting","explaining","remediating","completed"]},state:{enum:["started","completed","failed","info"]},message:{type:"string"},details:{type:"object",additionalProperties:true},createdAt:{type:"string",format:"date-time"}}}}
    }
  } as const;
}
