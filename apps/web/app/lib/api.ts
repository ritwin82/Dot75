import {headers} from "next/headers";
const internalApi=()=>process.env.API_INTERNAL_URL??process.env.NEXT_PUBLIC_API_URL??"http://localhost:4100";
const publicApi=()=>process.env.PUBLIC_API_URL??process.env.NEXT_PUBLIC_API_URL??"http://localhost:4100";
export async function apiFetch(path:string,init:RequestInit={}):Promise<Response>{const cookie=(await headers()).get("cookie");const requestHeaders=new Headers(init.headers);if(cookie)requestHeaders.set("cookie",cookie);return fetch(`${internalApi()}${path}`,{...init,headers:requestHeaders,cache:"no-store",signal:init.signal??AbortSignal.timeout(10000)});}
export const githubSignInUrl=(returnTo:string)=>`${publicApi()}/auth/github?returnTo=${encodeURIComponent(returnTo)}`;
