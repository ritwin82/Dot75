import {describe,expect,it,vi} from "vitest";
import type {Pool} from "pg";
import {migrateDatabase} from "./migrate.js";

describe("transactional database migrations",()=>{
  it("applies each migration once while holding the database lock",async()=>{
    const applied=new Set<string>();
    const query=vi.fn(async(sql:string,values?:unknown[])=>{
      if(sql.startsWith("SELECT name"))return {rows:[...applied].map((name)=>({name}))};
      if(sql.startsWith("INSERT INTO localmesh_schema_migrations")){applied.add(String(values?.[0]));return {rows:[]};}
      return {rows:[]};
    });
    const release=vi.fn();const pool={connect:vi.fn(async()=>({query,release}))} as unknown as Pool;
    await migrateDatabase(pool);await migrateDatabase(pool);
    expect([...applied]).toEqual(["001_validation_jobs.sql","002_events_and_audit.sql","003_engine_idempotency.sql","004_replay_inputs.sql","005_remediation_attempts.sql"]);
    expect(query.mock.calls.filter(([sql])=>sql==="COMMIT")).toHaveLength(5);
    expect(query).toHaveBeenCalledWith("SELECT pg_advisory_lock(750075)");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("rolls back a failed migration and releases the lock",async()=>{
    const query=vi.fn(async(sql:string)=>{if(sql.includes("CREATE TABLE IF NOT EXISTS job_events"))throw new Error("boom");return {rows:[]};});
    const release=vi.fn();const pool={connect:vi.fn(async()=>({query,release}))} as unknown as Pool;
    await expect(migrateDatabase(pool)).rejects.toThrow("002_events_and_audit.sql");
    expect(query).toHaveBeenCalledWith("ROLLBACK");expect(release).toHaveBeenCalled();
  });
});
