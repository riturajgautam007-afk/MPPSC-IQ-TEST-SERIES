"use strict";
require("dotenv").config();
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const dns=require("node:dns");dns.setDefaultResultOrder("ipv4first");
const {Pool}=require("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:15000});
const ROOT=path.resolve(__dirname,"..");
const baseTables=["students","tests","questions","attempts","wrong_questions","resources","question_bank_edits","question_bank_additions","student_memberships","membership_payment_requests"];
const optionalTables=["announcements","support_tickets","question_bookmarks","question_reports","revision_quiz_bookmarks","revision_quiz_reports","revision_quiz_progress","revision_quiz_answers"];
const serialTables=["students","tests","questions","attempts","wrong_questions","resources","question_bank_additions","student_memberships","membership_payment_requests","announcements","support_tickets","question_bookmarks","question_reports","revision_quiz_bookmarks","revision_quiz_reports"];
const assetLimits=new Map([["public/js/pre2027-revision-quiz.js",10*1024*1024],["public/pre2027-revision-quiz.html",2*1024*1024]]);
const requiredAssets=[...assetLimits.keys()];
function validateAssets(data){
 const entries=data.assets?.question_bank_files;
 if(entries===undefined)return {files:[],legacy:true};
 if(!Array.isArray(entries))throw Error("Question Bank assets का format गलत है");
 const byPath=new Map();
 for(const item of entries){
  if(!item||typeof item.path!=="string"||!assetLimits.has(item.path))throw Error("अनुमति-रहित Question Bank file path");
  if(byPath.has(item.path))throw Error("Backup में duplicate asset path: "+item.path);
  if(typeof item.content!=="string"||!item.content.length)throw Error("Question Bank asset खाली या invalid है: "+item.path);
  const bytes=Buffer.byteLength(item.content,"utf8"),limit=assetLimits.get(item.path);
  if(bytes>limit||Number(item.bytes)!==bytes)throw Error("Question Bank asset size mismatch: "+item.path);
  const digest=crypto.createHash("sha256").update(item.content,"utf8").digest("hex");
  if(typeof item.sha256!=="string"||digest!==item.sha256.toLowerCase())throw Error("Question Bank asset SHA-256 mismatch: "+item.path);
  byPath.set(item.path,{path:item.path,content:item.content,bytes,sha256:digest});
 }
 const missing=requiredAssets.filter(p=>!byPath.has(p));
 if(missing.length)throw Error("Backup में आवश्यक Question Bank file missing: "+missing.join(", "));
 return {files:[...byPath.values()],legacy:false};
}
function atomicWrite(target,content){
 const dir=path.dirname(target);fs.mkdirSync(dir,{recursive:true});
 const temp=path.join(dir,"."+path.basename(target)+"."+process.pid+"."+crypto.randomBytes(6).toString("hex")+".tmp");
 try{fs.writeFileSync(temp,content,{flag:"wx"});fs.renameSync(temp,target);}finally{try{if(fs.existsSync(temp))fs.unlinkSync(temp);}catch(_){}}
}
(async()=>{
 const file=process.argv[2];
 if(process.env.CONFIRM_RESTORE!=="YES")throw Error("Restore blocked. Set CONFIRM_RESTORE=YES after verifying the backup.");
 if(!file)throw Error("Usage: CONFIRM_RESTORE=YES node scripts/restore.js ./backup.json");
 const backupPath=path.resolve(process.cwd(),file);
 const data=JSON.parse(fs.readFileSync(backupPath,"utf8"));
 if(data.app!=="MPPSC IQ"||data.format_version!==1||!data.tables||typeof data.tables!=="object")throw Error("Unsupported or invalid MPPSC IQ backup file");
 for(const t of baseTables)if(!Array.isArray(data.tables[t]))throw Error("Backup table missing or invalid: "+t);
 const tables=[...baseTables,...optionalTables.filter(t=>Array.isArray(data.tables[t]))];
 const assets=validateAssets(data);
 if(process.env.DRY_RUN==="YES"){
  console.log("RESTORE_VALIDATION_OK",JSON.stringify({tables:Object.fromEntries(tables.map(t=>[t,data.tables[t].length])),assets:assets.files.map(x=>({path:x.path,bytes:x.bytes,sha256:x.sha256})),legacy_backup:assets.legacy,dry_run:true}));
  return;
 }
 const c=await pool.connect();
 const originals=[];
 let assetsWritten=false;
 try{
  // Verify table columns before making any destructive database change.
  for(const t of tables){
   const schema=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",[t]);
   if(!schema.rowCount)throw Error("Database table does not exist: "+t);
   const allowed=new Set(schema.rows.map(x=>x.column_name));
   for(const row of data.tables[t]){
    if(!row||typeof row!=="object"||Array.isArray(row))throw Error("Invalid row in table: "+t);
    for(const key of Object.keys(row))if(!allowed.has(key))throw Error("Unknown column in backup table "+t+": "+key);
   }
  }
  // Keep a copy of each current static asset outside the public directory for recovery.
  for(const asset of assets.files){
   const target=path.resolve(ROOT,asset.path);
   if(!target.startsWith(ROOT+path.sep))throw Error("Invalid asset destination");
   const previous=fs.existsSync(target)?fs.readFileSync(target):null;
   originals.push({target,previous});
  }
  await c.query("BEGIN");
  for(const t of [...tables].reverse())await c.query('DELETE FROM "'+t+'"');
  for(const t of tables){
   for(const row of data.tables[t]){
    const cols=Object.keys(row);if(!cols.length)continue;
    const sql='INSERT INTO "'+t+'" ('+cols.map(x=>'"'+x.replace(/"/g,'""')+'"').join(",")+') VALUES ('+cols.map((_,i)=>"$"+(i+1)).join(",")+')';
    await c.query(sql,cols.map(k=>row[k]));
   }
  }
  for(const t of serialTables.filter(t=>tables.includes(t))){
   const r=await c.query("SELECT pg_get_serial_sequence($1,'id') AS seq",[t]);
   if(r.rows[0]?.seq)await c.query("SELECT setval($1,COALESCE((SELECT MAX(id) FROM "+'"'+t+'"'+"),1),EXISTS(SELECT 1 FROM "+'"'+t+'"'+"))",[r.rows[0].seq]);
  }
  // Install validated assets before commit; if anything fails, restore their originals.
  for(const asset of assets.files)atomicWrite(path.resolve(ROOT,asset.path),asset.content);
  assetsWritten=assets.files.length>0;
  await c.query("COMMIT");
  console.log("RESTORE_OK",JSON.stringify({tables:Object.fromEntries(tables.map(t=>[t,data.tables[t].length])),assets:assets.files.map(x=>({path:x.path,bytes:x.bytes,sha256:x.sha256})),legacy_backup:assets.legacy}));
  if(assets.legacy)console.warn("RESTORE_WARNING: यह पुराना backup है; Question Bank source files शामिल नहीं थीं, इसलिए static files नहीं बदली गईं।");
 }catch(e){
  try{await c.query("ROLLBACK");}catch(_){}
  if(assetsWritten||originals.length){
   for(const item of originals){
    try{if(item.previous===null){if(fs.existsSync(item.target))fs.unlinkSync(item.target);}else atomicWrite(item.target,item.previous);}catch(restoreError){console.error("ASSET_ROLLBACK_FAILED:",item.target,restoreError.message);}
   }
  }
  throw e;
 }finally{c.release();}
})().catch(e=>{console.error("RESTORE_FAILED:",e.message);process.exitCode=1;}).finally(async()=>{await pool.end();});
