import {readdir,readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import type {Pool} from "pg";

const migrationsDirectory=fileURLToPath(new URL("../migrations/",import.meta.url));

export async function migrateDatabase(pool:Pool):Promise<void> {
  const client=await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(750075)");
    await client.query(`CREATE TABLE IF NOT EXISTS localmesh_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const {rows}=await client.query<{name:string}>("SELECT name FROM localmesh_schema_migrations");
    const applied=new Set(rows.map((row)=>row.name));
    const names=(await readdir(migrationsDirectory)).filter((name)=>/^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for(const name of names) {
      if(applied.has(name)) continue;
      const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),"utf8");
      await client.query("BEGIN");
      try {await client.query(sql);await client.query("INSERT INTO localmesh_schema_migrations(name) VALUES($1)",[name]);await client.query("COMMIT");}
      catch(error){await client.query("ROLLBACK");throw new Error(`Database migration ${name} failed`,{cause:error});}
    }
  } finally {
    try {await client.query("SELECT pg_advisory_unlock(750075)");} finally {client.release();}
  }
}
