import {createHash,randomBytes} from "node:crypto";
import type {Octokit} from "@octokit/rest";
import {parseMappings} from "@localmesh/contracts";

export const CONTRACTS_PATH = ".localmesh/contracts.yml";
export const EMPTY_CONTRACTS = "version: 2\nmappings: []\nschema_assertions: []\nsql_assertions: []\n";

async function readTextFile(octokit:Octokit,owner:string,repo:string,path:string,ref:string):Promise<string|undefined> {
  try {
    const {data}=await octokit.repos.getContent({owner,repo,path,ref});
    if(Array.isArray(data)||data.type!=="file"||!("content" in data)||data.encoding!=="base64") throw new Error(`GitHub did not return a complete ${path} file.`);
    const decoded=Buffer.from(data.content,"base64");
    if(decoded.length!==data.size) throw new Error(`GitHub returned incomplete contents for ${path}.`);
    return decoded.toString("utf8");
  } catch(error) {
    if((error as {status?:number}).status===404) return undefined;
    throw error;
  }
}

export interface ContractChangePreview {
  valid: true;
  digest: string;
  summary: {
    mappings: {before:number;after:number};
    schemaAssertions: {before:number;after:number};
    sqlAssertions: {before:number;after:number};
  };
}

export interface ContractRepositorySnapshot {
  defaultBranch: string;
  baseSha: string;
  source: string;
  preview: ContractChangePreview;
}

export function previewContractChange(currentSource:string|undefined,proposedSource:string):ContractChangePreview {
  const current=parseMappings(currentSource??EMPTY_CONTRACTS);
  const proposed=parseMappings(proposedSource);
  return {
    valid:true,
    digest:createHash("sha256").update(proposedSource).digest("hex"),
    summary:{
      mappings:{before:current.mappings?.length??0,after:proposed.mappings?.length??0},
      schemaAssertions:{before:current.schema_assertions?.length??0,after:proposed.schema_assertions?.length??0},
      sqlAssertions:{before:current.sql_assertions?.length??0,after:proposed.sql_assertions?.length??0}
    }
  };
}

export async function readContractConfiguration(octokit:Octokit,owner:string,repo:string):Promise<ContractRepositorySnapshot> {
  const repository=await octokit.repos.get({owner,repo});
  const defaultBranch=repository.data.default_branch;
  const branch=await octokit.repos.getBranch({owner,repo,branch:defaultBranch});
  const baseSha=branch.data.commit.sha;
  const source=await readTextFile(octokit,owner,repo,CONTRACTS_PATH,baseSha)??EMPTY_CONTRACTS;
  return {defaultBranch,baseSha,source,preview:previewContractChange(source,source)};
}

export async function createContractConfigurationPullRequest(octokit:Octokit,options:{
  owner:string;
  repo:string;
  expectedBaseSha:string;
  proposedSource:string;
  actor:string;
}):Promise<{number:number;url:string;branch:string;baseSha:string;preview:ContractChangePreview}> {
  const repository=await octokit.repos.get({owner:options.owner,repo:options.repo});
  if(repository.data.permissions?.push!==true) throw new Error("GitHub reports that this account cannot push a configuration branch to the repository.");
  const defaultBranch=repository.data.default_branch;
  const branch=await octokit.repos.getBranch({owner:options.owner,repo:options.repo,branch:defaultBranch});
  const baseSha=branch.data.commit.sha;
  if(baseSha!==options.expectedBaseSha) throw new Error(`The default branch changed from ${options.expectedBaseSha} to ${baseSha}. Refresh the preview before publishing.`);

  const currentSource=await readTextFile(octokit,options.owner,options.repo,CONTRACTS_PATH,baseSha);
  const preview=previewContractChange(currentSource,options.proposedSource);
  const suffix=`${new Date().toISOString().slice(0,10).replaceAll("-","")}-${preview.digest.slice(0,8)}-${randomBytes(2).toString("hex")}`;
  const configBranch=`dot75/contracts-${suffix}`;
  await octokit.git.createRef({owner:options.owner,repo:options.repo,ref:`refs/heads/${configBranch}`,sha:baseSha});

  let existingSha:string|undefined;
  try {
    const existing=await octokit.repos.getContent({owner:options.owner,repo:options.repo,path:CONTRACTS_PATH,ref:baseSha});
    if(!Array.isArray(existing.data)&&existing.data.type==="file") existingSha=existing.data.sha;
  } catch(error) {
    if((error as {status?:number}).status!==404) throw error;
  }
  await octokit.repos.createOrUpdateFileContents({
    owner:options.owner,repo:options.repo,path:CONTRACTS_PATH,branch:configBranch,
    message:"chore(dot75): update migration contracts",
    content:Buffer.from(options.proposedSource,"utf8").toString("base64"),
    ...(existingSha?{sha:existingSha}:{})
  });
  const counts=preview.summary;
  const pull=await octokit.pulls.create({
    owner:options.owner,repo:options.repo,head:configBranch,base:defaultBranch,
    title:"Configure Dot75 migration contracts",
    body:[
      "## Dot75 contract mapping update",
      "",
      `Requested by @${options.actor.replaceAll("@","")}.`,
      `Preview base: \`${baseSha}\``,
      `Configuration digest: \`${preview.digest}\``,
      "",
      `- Template mappings: ${counts.mappings.before} → ${counts.mappings.after}`,
      `- Schema assertions: ${counts.schemaAssertions.before} → ${counts.schemaAssertions.after}`,
      `- SQL assertions: ${counts.sqlAssertions.before} → ${counts.sqlAssertions.after}`,
      "",
      "Dot75 changed only `.localmesh/contracts.yml`. Merge through the repository's normal review and required-check policy."
    ].join("\n")
  });
  return {number:pull.data.number,url:pull.data.html_url,branch:configBranch,baseSha,preview};
}
