import {afterEach,describe,expect,it} from "vitest";
import {PostgresValidationEnvironment} from "./runtime.js";

const environments:PostgresValidationEnvironment[]=[];
describe.skipIf(process.env.RUN_POSTGRES_MATRIX!=="1")("PostgreSQL compatibility matrix",()=>{
  afterEach(async()=>{await Promise.all(environments.splice(0).map((environment)=>environment.stop()));});
  it.each(["14","15","16","17"])("runs isolated validation on PostgreSQL %s",async(version)=>{const environment=await PostgresValidationEnvironment.start(version);environments.push(environment);const actual=await environment.withDatabase([],[],async(pool)=>(await pool.query<{version:string}>("SELECT current_setting('server_version') AS version")).rows[0]!.version);expect(actual.startsWith(version)).toBe(true);});
});
