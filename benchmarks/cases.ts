import type {MigrationFile} from "@localmesh/shared";
export interface BenchmarkCase{id:string;expected:"conflict"|"safe";baseline:MigrationFile[];a:MigrationFile[];b:MigrationFile[]}
const up=(path:string,sql:string,order=1):MigrationFile=>({path,sql,direction:"up",order});
export const benchmarkCases:BenchmarkCase[]=[
  ...Array.from({length:20},(_,i)=>{const n=i+1;return{id:`duplicate-column-${n}`,expected:"conflict" as const,baseline:[up(`000_${n}.up.sql`,`CREATE TABLE entity_${n} (id bigint PRIMARY KEY, value text);`,0)],a:[up(`100_${n}.up.sql`,`ALTER TABLE entity_${n} ADD COLUMN shared_${n} text;`)],b:[up(`101_${n}.up.sql`,`ALTER TABLE entity_${n} ADD COLUMN shared_${n} integer;`)]};}),
  ...Array.from({length:20},(_,i)=>{const n=i+1;return{id:`independent-tables-${n}`,expected:"safe" as const,baseline:[up(`000_${n}.up.sql`,`CREATE TABLE left_${n} (id bigint PRIMARY KEY); CREATE TABLE right_${n} (id bigint PRIMARY KEY);`,0)],a:[up(`100_${n}.up.sql`,`ALTER TABLE left_${n} ADD COLUMN feature_a text;`)],b:[up(`101_${n}.up.sql`,`ALTER TABLE right_${n} ADD COLUMN feature_b integer;`)]};})
];
