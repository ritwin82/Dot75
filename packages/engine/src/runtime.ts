import { createHash, randomUUID } from "node:crypto";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Pool } from "pg";
import { diffObjects, inspectSchema } from "@localmesh/inspector";
import type { DataStateSnapshot, Finding, MigrationFile, OrderResult, RollbackResult, SchemaSnapshot, SqlExecutionStep } from "@localmesh/shared";
import { destructiveStatements } from "./performance.js";

const safeIdentifier = (value: string) => `"${value.replaceAll('"','""')}"`;
const maxRecordedSqlCharacters = 24_000;
const statementCount = (sql: string) => Math.max(1, sql.split(";").filter((statement) => statement.trim()).length);
function recordedSql(sql: string): Pick<SqlExecutionStep, "sql" | "sqlTruncated"> {
  return sql.length > maxRecordedSqlCharacters ? { sql: sql.slice(0, maxRecordedSqlCharacters), sqlTruncated: true } : { sql };
}

export class PostgresValidationEnvironment {
  private constructor(private readonly container: StartedTestContainer, private readonly adminUrl: string) {}

  static async start(version: string): Promise<PostgresValidationEnvironment> {
    const memory=Math.min(Math.max(Number(process.env.LOCALMESH_CONTAINER_MEMORY_MB??512),512),4096)*1024*1024;
    const cpu=Math.min(Math.max(Number(process.env.LOCALMESH_CONTAINER_CPUS??1),0.25),8);
    const container = await new GenericContainer(`postgres:${version}-alpine`)
      .withEnvironment({ POSTGRES_PASSWORD:"localmesh", POSTGRES_USER:"localmesh", POSTGRES_DB:"postgres" })
      .withResourcesQuota({memory,cpu})
      .withTmpFs({"/var/lib/postgresql/data":"rw,nosuid,nodev,size=384m","/tmp":"rw,nosuid,nodev,noexec,size=64m"})
      .withExposedPorts(5432)
      .withHealthCheck({ test:["CMD-SHELL","pg_isready -U localmesh"], interval:1000, timeout:3000, retries:30 })
      .start();
    const url = `postgresql://localmesh:localmesh@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
    return new PostgresValidationEnvironment(container,url);
  }

  async stop(): Promise<void> { await this.container.stop(); }

  async withDatabase<T>(files:MigrationFile[],extensions:string[],callback:(pool:Pool)=>Promise<T>):Promise<T>{
    const {pool,name}=await this.database(files,extensions); try{return await callback(pool);}finally{await this.disposeDatabase(pool,name);}
  }

  private async dropDatabase(name:string):Promise<void>{
    const admin=new Pool({connectionString:this.adminUrl});
    try{await admin.query(`DROP DATABASE IF EXISTS ${safeIdentifier(name)} WITH (FORCE)`);await admin.query(`DROP ROLE IF EXISTS ${safeIdentifier(name)}`);}finally{await admin.end();}
  }

  private async disposeDatabase(pool:Pool,name:string):Promise<void>{await pool.end();await this.dropDatabase(name);}

  private async database(files: MigrationFile[], extensions: string[]): Promise<{ pool:Pool; before:SchemaSnapshot;name:string }> {
    const name = `lm_${randomUUID().replaceAll("-","")}`;
    const password=randomUUID().replaceAll("-","");
    const admin = new Pool({ connectionString:this.adminUrl });
    try{await admin.query(`CREATE ROLE ${safeIdentifier(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);await admin.query(`CREATE DATABASE ${safeIdentifier(name)} OWNER ${safeIdentifier(name)}`);}finally{await admin.end();}
    const databaseUrl=new URL(this.adminUrl);databaseUrl.username=name;databaseUrl.password=password;databaseUrl.pathname=`/${name}`;
    const timeout=Math.min(Math.max(Number(process.env.LOCALMESH_STATEMENT_TIMEOUT_MS??30_000),100),300_000);
    const pool = new Pool({ connectionString:databaseUrl.toString(),max:4,connectionTimeoutMillis:10_000,statement_timeout:timeout,query_timeout:timeout+1000 });
    try {
    for (const extension of extensions) await pool.query(`CREATE EXTENSION IF NOT EXISTS ${safeIdentifier(extension)}`);
    for (const file of files.filter((f) => f.direction === "up").sort((a,b) => a.order-b.order || a.path.localeCompare(b.path))) await pool.query(file.sql);
    const client = await pool.connect();
    try { return { pool, before:await inspectSchema(client),name }; } finally { client.release(); }
    } catch (error) { await this.disposeDatabase(pool,name); throw error; }
  }

  async inspectChange(baseline: MigrationFile[], change: MigrationFile[], extensions: string[]): Promise<{ snapshot:SchemaSnapshot; affected:ReturnType<typeof diffObjects>; findings:Finding[] }> {
    const { pool, before,name } = await this.database(baseline,extensions);
    const findings: Finding[] = [];
    try {
      for (const file of change.filter((f) => f.direction === "up").sort((a,b)=>a.order-b.order)) {
        try { await pool.query(file.sql); } catch (error) { findings.push(sqlError(error,file.path,file.sql)); break; }
      }
      const client = await pool.connect();
      try { const snapshot=await inspectSchema(client); return { snapshot, affected:diffObjects(before,snapshot), findings }; } finally { client.release(); }
    } finally { await this.disposeDatabase(pool,name); }
  }

  async executeOrder(baseline:MigrationFile[], groups:{pr:number;files:MigrationFile[]}[], extensions:string[], options: { fixtures?: string[]; verify?: (pool: Pool, snapshot: SchemaSnapshot) => Promise<Finding[]>; compareDataState?: boolean; excludeDataColumns?: string[] } = {}):Promise<OrderResult> {
    const started=Date.now(); const findings:Finding[]=[]; const executionSteps:SqlExecutionStep[]=[]; const {pool,before,name}=await this.database(baseline,extensions);
    try {
      for (const fixture of options.fixtures ?? []) await pool.query(fixture);
      outer: for (const group of groups) for (const file of group.files.filter((f)=>f.direction==="up").sort((a,b)=>a.order-b.order || a.path.localeCompare(b.path))) {
        const fileStarted=Date.now();
        try {
          await pool.query(file.sql);
          executionSteps.push({pr:group.pr,file:file.path,direction:"up",phase:"migration",status:"passed",durationMs:Date.now()-fileStarted,statementCount:statementCount(file.sql),...recordedSql(file.sql)});
        } catch(error) {
          const failure=sqlError(error,file.path,file.sql);
          findings.push({ ...failure, evidence:{ ...failure.evidence, pr:group.pr } });
          executionSteps.push({pr:group.pr,file:file.path,direction:"up",phase:"migration",status:"failed",durationMs:Date.now()-fileStarted,statementCount:statementCount(file.sql),...recordedSql(file.sql),errorCode:failure.code,errorMessage:failure.message,...(failure.line?{errorLine:failure.line}:{})});
          break outer;
        }
      }
      const sqlPassed = !findings.some((f)=>f.severity==="error");
      const client = await pool.connect();
      let snapshot: SchemaSnapshot;
      try { snapshot = await inspectSchema(client); } finally { client.release(); }
      if (sqlPassed && options.verify) findings.push(...await options.verify(pool, snapshot));
      const dataState = sqlPassed && options.compareDataState !== false ? await captureDataState(pool, options.excludeDataColumns) : undefined;
      return { order:groups.map((g)=>g.pr), passed:!findings.some((f)=>f.severity==="error"), sqlPassed, contractsChecked: sqlPassed && !!options.verify,
        findings, ...(sqlPassed ? {finalFingerprint:snapshot.fingerprint}:{}), ...(dataState ? {dataState}:{}), snapshot, affectedObjects: diffObjects(before, snapshot), executionSteps, durationMs:Date.now()-started };
    } finally { await this.disposeDatabase(pool,name); }
  }

  async verifyRollback(baseline:MigrationFile[], up:MigrationFile, down:MigrationFile|undefined, extensions:string[],fixtures:string[]=[],prior:MigrationFile[]=[]):Promise<RollbackResult> {
    const started=Date.now();
    if (!down) return { migration:up.path,upFile:up.path,status:"non_reversible",schemaRestored:false,sqlPassed:false,durationMs:Date.now()-started,executionSteps:[],findings:[{code:"NO_DOWN_MIGRATION",severity:"warning",title:"Migration is non-reversible",message:`No down migration is paired with ${up.path}.`,file:up.path}] };
    const {pool,name}=await this.database(baseline,extensions); const findings=[...destructiveStatements(up)];const executionSteps:SqlExecutionStep[]=[];
    try {
      for(const fixture of fixtures)await pool.query(fixture);
      for(const file of prior.filter((file)=>file.direction==="up").sort((a,b)=>a.order-b.order || a.path.localeCompare(b.path)))await pool.query(file.sql);
      const beforeClient=await pool.connect();let before:SchemaSnapshot;try{before=await inspectSchema(beforeClient);}finally{beforeClient.release();}
      const dataBefore=(await captureDataState(pool)).fingerprint;
      let upPassed=true;
      const upStarted=Date.now();
      try { await pool.query(up.sql); executionSteps.push({file:up.path,direction:"up",phase:"rollback",status:"passed",durationMs:Date.now()-upStarted,statementCount:statementCount(up.sql),...recordedSql(up.sql)}); }
      catch(error){upPassed=false;const failure=sqlError(error,up.path,up.sql);findings.push(failure);executionSteps.push({file:up.path,direction:"up",phase:"rollback",status:"failed",durationMs:Date.now()-upStarted,statementCount:statementCount(up.sql),...recordedSql(up.sql),errorCode:failure.code,errorMessage:failure.message,...(failure.line?{errorLine:failure.line}:{})});}
      let downPassed=false;
      if(upPassed){const downStarted=Date.now();try{await pool.query(down.sql);downPassed=true;executionSteps.push({file:down.path,direction:"down",phase:"rollback",status:"passed",durationMs:Date.now()-downStarted,statementCount:statementCount(down.sql),...recordedSql(down.sql)});}catch(error){const failure=sqlError(error,down.path,down.sql);findings.push(failure);executionSteps.push({file:down.path,direction:"down",phase:"rollback",status:"failed",durationMs:Date.now()-downStarted,statementCount:statementCount(down.sql),...recordedSql(down.sql),errorCode:failure.code,errorMessage:failure.message,...(failure.line?{errorLine:failure.line}:{})});}}
      else executionSteps.push({file:down.path,direction:"down",phase:"rollback",status:"skipped",durationMs:0,statementCount:statementCount(down.sql),...recordedSql(down.sql),errorMessage:"Skipped because the up migration failed."});
      const client=await pool.connect(); let after:SchemaSnapshot; try { after=await inspectSchema(client); } finally {client.release();}
      const dataAfter=(await captureDataState(pool)).fingerprint;const dataRestored=dataBefore===dataAfter;
      if (before.fingerprint!==after.fingerprint) findings.push({code:"ROLLBACK_SCHEMA_MISMATCH",severity:"error",title:"Rollback did not restore the schema",message:"The catalog fingerprint after rollback differs from the original.",file:down.path,evidence:{before:before.fingerprint,after:after.fingerprint,objects:diffObjects(before,after).map((o)=>o.id)}});
      if(!dataRestored)findings.push({code:"ROLLBACK_DATA_MISMATCH",severity:"error",title:"Rollback did not restore fixture data",message:"Row hashes after rollback differ from the pre-migration fixture state.",file:down.path,evidence:{before:dataBefore,after:dataAfter}});
      const changedObjects=diffObjects(before,after).map((object)=>object.id);const unsafe=findings.some((f)=>f.severity==="error" || f.code.startsWith("DROP_") || f.code==="TYPE_CONVERSION");
      return {migration:up.path,upFile:up.path,downFile:down.path,status:unsafe?"unsafe":"safe",schemaRestored:before.fingerprint===after.fingerprint,dataRestored,sqlPassed:upPassed&&downPassed,durationMs:Date.now()-started,executionSteps,beforeSchemaFingerprint:before.fingerprint,afterSchemaFingerprint:after.fingerprint,beforeDataFingerprint:dataBefore,afterDataFingerprint:dataAfter,changedObjects,findings};
    } finally {await this.disposeDatabase(pool,name);}
  }
}

export async function captureDataState(pool:Pool,excludedColumns:string[]=[]):Promise<DataStateSnapshot>{
  const {rows}=await pool.query<{schemaname:string;tablename:string}>(`SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`);
  const tables=[];
  for(const table of rows){
    const tableName=`${table.schemaname}.${table.tablename}`;const target=`${safeIdentifier(table.schemaname)}.${safeIdentifier(table.tablename)}`;
    const excluded=excludedColumns.filter((column)=>column.startsWith(`${tableName}.`)).map((column)=>column.slice(tableName.length+1));
    const result=await pool.query<{hash:string;count:string}>(`SELECT md5(coalesce(string_agg((to_jsonb(t) - $1::text[])::text, E'\\n' ORDER BY (to_jsonb(t) - $1::text[])::text),'')) hash,count(*)::text count FROM ${target} t`,[excluded]);
    const sample=await pool.query<{value:Record<string,unknown>}>(`SELECT to_jsonb(t) - $1::text[] value FROM ${target} t ORDER BY (to_jsonb(t) - $1::text[])::text LIMIT 5`,[excluded]);
    tables.push({table:tableName,rowCount:Number(result.rows[0]?.count??0),fingerprint:result.rows[0]?.hash??"",sampleRows:sample.rows.map((row)=>row.value)});
  }
  const sequenceRows=await pool.query<{schema:string;name:string}>(`SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`);
  const sequences=[];for(const sequence of sequenceRows.rows){const name=`${sequence.schema}.${sequence.name}`;const state=await pool.query<{last_value:string;is_called:boolean}>(`SELECT last_value::text,is_called FROM ${safeIdentifier(sequence.schema)}.${safeIdentifier(sequence.name)}`);const value=state.rows[0];sequences.push({sequence:name,...(value?.last_value!==undefined?{lastValue:value.last_value}:{}),isCalled:value?.is_called??false});}
  const fingerprint=createHash("sha256").update(JSON.stringify({tables:tables.map(({sampleRows:_,...table})=>table),sequences})).digest("hex");return {tables,sequences,fingerprint};
}

export function sqlError(error:unknown,file:string,sql?:string):Finding {
  const e=error as {message?:string;code?:string;detail?:string;position?:string};
  const position = Number(e.position);
  const line = sql !== undefined && Number.isInteger(position) && position > 0 && position <= [...sql].length + 1
    ? [...sql].slice(0, position - 1).join("").split("\n").length : undefined;
  return {...(line ? {line} : {}),code:e.code??"SQL_EXECUTION_FAILED",severity:"error",title:"PostgreSQL rejected the migration",message:e.message??String(error),file,evidence:{detail:e.detail,position:e.position}};
}
