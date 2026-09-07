import type {Octokit} from "@octokit/rest";
export type RepositoryRole="viewer"|"maintainer"|"admin";
const rank:Record<RepositoryRole,number>={viewer:0,maintainer:1,admin:2};
export function repositoryRole(permissions:{admin?:boolean;maintain?:boolean;push?:boolean;triage?:boolean;pull?:boolean}|undefined):RepositoryRole|undefined{
  if(permissions?.admin)return"admin";if(permissions?.maintain||permissions?.push)return"maintainer";if(permissions?.triage||permissions?.pull)return"viewer";return undefined;
}
export async function authorizeRepository(client:Octokit,owner:string,repo:string,minimum:RepositoryRole="viewer"):Promise<RepositoryRole|undefined>{
  try{const {data}=await client.repos.get({owner,repo});const role=repositoryRole(data.permissions);return role&&rank[role]>=rank[minimum]?role:undefined;}catch{return undefined;}
}
