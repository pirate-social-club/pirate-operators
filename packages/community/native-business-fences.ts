import { insist } from "./common.ts";
export interface NativeBusinessFence { sql:string; values:(string|number|null)[] }
/** Capture existing authority rows before the handler awaits. The final primary
 * batch must still see every byte and row; no settings/history is rewritten. */
export async function nativeLearningFences(db:D1Database,account:string):Promise<NativeBusinessFence[]> {
  const fences:NativeBusinessFence[]=[];
  for(const table of ["learning_settings","learning_authorizations","learning_authority_heads",
    "learning_authority_original_heads","learning_authority_credentials","learning_authority_dirty"]){
    const rows=(await db.withSession("first-primary").prepare(
      `SELECT rowid AS native_rowid,* FROM ${table} WHERE account_id=? ORDER BY rowid LIMIT 257`,
    ).bind(account).all<Record<string,unknown>>()).results;
    insist(rows.length<=256,"native_authority_snapshot_bound",503);
    fences.push({sql:`(SELECT count(*) FROM ${table} WHERE account_id=?)=?`,values:[account,rows.length]});
    for(const row of rows){
      const values:(string|number|null)[]=[];
      const columns=Object.entries(row).map(([column,value])=>{
        insist(/^[a-z_]+$/.test(column) && (value===null||typeof value==="string"||typeof value==="number"),
          "native_authority_schema_changed",503);
        values.push(value);
        return (column==="native_rowid"?"rowid":'"'+column+'"')+" IS ?";
      });
      fences.push({sql:`EXISTS(SELECT 1 FROM ${table} WHERE ${columns.join(" AND ")})`,values});
    }
  }
  return fences;
}
