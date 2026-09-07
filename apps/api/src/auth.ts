import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from "node:crypto";
import type {FastifyInstance,FastifyRequest} from "fastify";

const SESSION_COOKIE="dot75_session";
const STATE_COOKIE="dot75_oauth_state";

export interface GitHubSession {
  login: string;
  avatarUrl: string;
  accessToken: string;
  csrf: string;
  expiresAt: number;
}

function encryptionKey(secret:string):Buffer {
  if(secret.length<32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

export function sealSession(value:unknown,secret:string):string {
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",encryptionKey(secret),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return [iv,cipher.getAuthTag(),encrypted].map((part)=>part.toString("base64url")).join(".");
}

export function openSession<T>(sealed:string|undefined,secret:string):T|undefined {
  if(!sealed) return undefined;
  try {
    const [ivSource,tagSource,encryptedSource]=sealed.split(".");
    if(!ivSource||!tagSource||!encryptedSource) return undefined;
    const iv=Buffer.from(ivSource,"base64url"); const tag=Buffer.from(tagSource,"base64url");
    const decipher=createDecipheriv("aes-256-gcm",encryptionKey(secret),iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedSource,"base64url")),decipher.final()]).toString("utf8")) as T;
  } catch { return undefined; }
}

function cookie(request:FastifyRequest,name:string):string|undefined {
  for(const part of (request.headers.cookie??"").split(";")) {
    const [key,...value]=part.trim().split("="); if(key===name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function serializeCookie(name:string,value:string,maxAge:number):string {
  const secure=process.env.NODE_ENV==="production"?"; Secure":"";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function safeReturnTo(value:unknown):string {
  return typeof value==="string"&&value.startsWith("/")&&!value.startsWith("//")?value:"/dashboard";
}

function secret():string {const value=process.env.SESSION_SECRET;if(!value)throw new Error("SESSION_SECRET is required for GitHub sign-in");return value;}

export function githubSession(request:FastifyRequest):GitHubSession|undefined {
  const configured=process.env.SESSION_SECRET; if(!configured) return undefined;
  const session=openSession<GitHubSession>(cookie(request,SESSION_COOKIE),configured);
  if(!session||session.expiresAt<=Date.now()) return undefined;
  return session;
}

export function validCsrf(request:FastifyRequest,session:GitHubSession):boolean {
  const supplied=request.headers["x-dot75-csrf"];
  if(typeof supplied!=="string") return false;
  const left=Buffer.from(supplied); const right=Buffer.from(session.csrf);
  return left.length===right.length&&timingSafeEqual(left,right);
}

export function registerGitHubAuth(server:FastifyInstance):void {
  server.get("/auth/github",async(request,reply)=>{
    const clientId=process.env.GITHUB_OAUTH_CLIENT_ID;
    if(!clientId) return reply.code(503).send({error:"GitHub OAuth is not configured"});
    const state=randomBytes(24).toString("base64url"); const returnTo=safeReturnTo((request.query as {returnTo?:string}).returnTo);
    reply.header("set-cookie",serializeCookie(STATE_COOKIE,sealSession({state,returnTo,expiresAt:Date.now()+10*60_000},secret()),600));
    const authorize=new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id",clientId); authorize.searchParams.set("scope","repo read:user"); authorize.searchParams.set("state",state);
    return reply.redirect(authorize.toString());
  });

  server.get("/auth/github/callback",async(request,reply)=>{
    const {code,state}=request.query as {code?:string;state?:string};
    const oauthState=openSession<{state:string;returnTo:string;expiresAt:number}>(cookie(request,STATE_COOKIE),secret());
    if(!code||!state||!oauthState||oauthState.expiresAt<=Date.now()||state!==oauthState.state) return reply.code(401).send({error:"The GitHub sign-in request is invalid or expired"});
    const clientId=process.env.GITHUB_OAUTH_CLIENT_ID; const clientSecret=process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if(!clientId||!clientSecret) return reply.code(503).send({error:"GitHub OAuth is not configured"});
    const tokenResponse=await fetch("https://github.com/login/oauth/access_token",{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,state})});
    const token=await tokenResponse.json() as {access_token?:string;error_description?:string};
    if(!tokenResponse.ok||!token.access_token) return reply.code(401).send({error:token.error_description??"GitHub did not issue an access token"});
    const userResponse=await fetch("https://api.github.com/user",{headers:{accept:"application/vnd.github+json",authorization:`Bearer ${token.access_token}`,"user-agent":"dot75-self-hosted","x-github-api-version":"2022-11-28"}});
    const user=await userResponse.json() as {login?:string;avatar_url?:string};
    if(!userResponse.ok||!user.login) return reply.code(401).send({error:"GitHub user identity could not be loaded"});
    const session:GitHubSession={login:user.login,avatarUrl:user.avatar_url??"",accessToken:token.access_token,csrf:randomBytes(24).toString("base64url"),expiresAt:Date.now()+12*60*60_000};
    reply.header("set-cookie",[
      serializeCookie(SESSION_COOKIE,sealSession(session,secret()),12*60*60),
      serializeCookie(STATE_COOKIE,"",0)
    ]);
    return reply.redirect(`${process.env.WEB_ORIGIN??"http://localhost:3000"}${safeReturnTo(oauthState.returnTo)}`);
  });

  server.get("/api/session",async(request)=>{
    const session=githubSession(request);
    return session?{authenticated:true,user:{login:session.login,avatarUrl:session.avatarUrl},csrf:session.csrf}:{authenticated:false};
  });
  server.post("/api/session/logout",async(request,reply)=>{
    const session=githubSession(request);
    if(session&&!validCsrf(request,session)) return reply.code(403).send({error:"Invalid CSRF token"});
    reply.header("set-cookie",serializeCookie(SESSION_COOKIE,"",0)); return {authenticated:false};
  });
}
