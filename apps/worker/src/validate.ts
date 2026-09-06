import {randomUUID} from "node:crypto";
import {parseMappings,runDataContracts,validateSchemaContracts} from "@localmesh/contracts";
import {analyzePerformance,areRelated,deterministicExplanation,explainWithOllama,PostgresValidationEnvironment} from "@localmesh/engine";
import {getTextFile,installationClient,listMigrations,listSqlFiles,markCheckInfrastructureFailure,markCheckRunning,openPullRequests,pullRequestMigrations,updateCheck} from "@localmesh/github";
import {defaultConfig,parseConfig,parseOperationalMetadata,type Finding,type ValidationJob,type ValidationResult} from "@localmesh/shared";
import {isJobCancelled,setJobStatus} from "@localmesh/db";

export async function validateJob(job:ValidationJob):Promise<ValidationResult>{
  const octokit=await installationClient(job.installationId);if(job.checkRunId)await markCheckRunning(octokit,job.owner,job.repo,job.checkRunId);
  let environment:PostgresValidationEnvironment|undefined;
  try{
    await setJobStatus(job.id,"running");
    const configText=await getTextFile(octokit,job.owner,job.repo,"localmesh.yml",job.headSha);
    const config=configText?parseConfig(configText):defaultConfig;
    const baseline=await listMigrations(octokit,job.owner,job.repo,job.baseSha,config.migrations.directory);
    const currentFiles=await pullRequestMigrations(octokit,job.owner,job.repo,job.prNumber,job.headSha,config.migrations.directory);
    const startedAt=new Date().toISOString(); environment=await PostgresValidationEnvironment.start(config.postgres.version);
    const current=await environment.inspectChange(baseline,currentFiles,config.postgres.extensions);
    const orders=[]; const compared:number[]=[]; const currentSingle=await environment.executeOrder(baseline,[{pr:job.prNumber,files:currentFiles}],config.postgres.extensions);orders.push(currentSingle);
    if(config.checks.compare_open_pull_requests){
      for(const pr of await openPullRequests(octokit,job.owner,job.repo,job.prNumber)){
        const files=await pullRequestMigrations(octokit,job.owner,job.repo,pr.number,pr.headSha,config.migrations.directory);if(!files.some((f)=>f.direction==="up"))continue;
        const candidate=await environment.inspectChange(baseline,files,config.postgres.extensions);
        const related=current.findings.length>0||candidate.findings.length>0||areRelated({pr:job.prNumber,objects:current.affected,edges:current.snapshot.edges},{pr:pr.number,objects:candidate.affected,edges:candidate.snapshot.edges});
        if(!related)continue;compared.push(pr.number);
        const ab=await environment.executeOrder(baseline,[{pr:job.prNumber,files:currentFiles},{pr:pr.number,files}],config.postgres.extensions);
        const ba=await environment.executeOrder(baseline,[{pr:pr.number,files},{pr:job.prNumber,files:currentFiles}],config.postgres.extensions);
        if(ab.passed&&ba.passed&&ab.finalFingerprint!==ba.finalFingerprint){const finding:Finding={code:"ORDER_SCHEMA_DIVERGENCE",severity:"error",title:"Migration order changes the final schema",message:`PR #${job.prNumber} and PR #${pr.number} both execute, but produce different catalog fingerprints.`,evidence:{objects:[...current.affected,...candidate.affected].map((o)=>o.id),ab:ab.finalFingerprint,ba:ba.finalFingerprint}};ab.findings.push(finding);ba.findings.push(finding);ab.passed=false;ba.passed=false;}
        orders.push(ab,ba);
      }
    }
    const fixtures=await listSqlFiles(octokit,job.owner,job.repo,job.headSha,config.contracts.fixtures_directory);let contracts:Finding[]=[];const mappingText=await getTextFile(octokit,job.owner,job.repo,config.contracts.mappings_file,job.headSha);
    if(mappingText){const mappings=parseMappings(mappingText);contracts.push(...validateSchemaContracts(current.snapshot.objects,mappings));if(fixtures.length){const data=await environment.withDatabase([...baseline,...currentFiles],config.postgres.extensions,async(pool)=>{for(const fixture of fixtures)await pool.query(fixture.sql);return runDataContracts(pool,mappings);});contracts.push(...data);}else if(config.checks.require_data_contracts)contracts.push({code:"FIXTURES_REQUIRED",severity:"error",title:"Data fixtures are required",message:`No SQL fixtures were found under ${config.contracts.fixtures_directory}.`});}
    const rollbacks=[];if(config.checks.verify_rollback)for(const up of currentFiles.filter((f)=>f.direction==="up")){const down=currentFiles.find((f)=>f.path===up.path.replace(/\.up\.sql$/,".down.sql"));rollbacks.push(await environment.verifyRollback(baseline,up,down,config.postgres.extensions,fixtures.map((f)=>f.sql)));}
    const metadataText=await getTextFile(octokit,job.owner,job.repo,config.performance.metadata_file,job.headSha);const performance=analyzePerformance(currentFiles,metadataText?parseOperationalMetadata(metadataText):[]);const deterministic=[...orders.flatMap((o)=>o.findings),...contracts,...rollbacks.flatMap((r)=>r.findings),...performance];
    const explanation=config.ai?await explainWithOllama(deterministic,currentFiles.map((f)=>f.sql).join("\n"),{url:process.env.OLLAMA_URL??"http://localhost:11434",model:config.ai.model}):deterministicExplanation(deterministic);
    const failed=[...orders.flatMap((o)=>o.findings),...contracts,...rollbacks.flatMap((r)=>r.findings)].some((f)=>f.severity==="error");
    const cancelled=await isJobCancelled(job.id);const result:ValidationResult={jobId:job.id,status:cancelled?"cancelled":failed?"failed":"passed",repository:`${job.owner}/${job.repo}`,currentPr:job.prNumber,baseSha:job.baseSha,headSha:job.headSha,startedAt,completedAt:new Date().toISOString(),affectedObjects:current.affected,dependencies:current.snapshot.edges,comparedPullRequests:compared,orders,contracts,rollbacks,performance,explanation};
    await setJobStatus(job.id,result.status,result);if(job.checkRunId)await updateCheck(octokit,job.owner,job.repo,job.checkRunId,result);return result;
  }catch(error){const message=error instanceof Error?error.stack??error.message:String(error);await setJobStatus(job.id,"failed",undefined,message);if(job.checkRunId)await markCheckInfrastructureFailure(octokit,job.owner,job.repo,job.checkRunId,message);throw error;}finally{await environment?.stop();}
}

export function demoJob():ValidationJob{return{id:randomUUID(),installationId:0,owner:"demo",repo:"demo",prNumber:1,headSha:"demo",baseSha:"demo"};}
