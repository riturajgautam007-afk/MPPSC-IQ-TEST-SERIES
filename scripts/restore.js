"use strict";
require("dotenv").config();
const fs=require("node:fs");
const dns=require("node:dns");dns.setDefaultResultOrder("ipv4first");
const {Pool}=require("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:15000});
const baseTables=["students","tests","questions","attempts","wrong_questions","resources","question_bank_edits","question_bank_additions","student_memberships","membership_payment_requests"];
const optionalTables=["announcements","support_tickets","question_bookmarks","question_reports","revision_quiz_bookmarks","revision_quiz_reports","revision_quiz_progress","revision_quiz_answers"];
const serialTables=["students","tests","questions","attempts","wrong_questions","resources","question_bank_additions","student_memberships","membership_payment_requests","announcements","support_tickets","question_bookmarks","question_reports","revision_quiz_bookmarks","revision_quiz_reports"];
(async()=>{
 const file=process.argv[2];
 if(process.env.CONFIRM_RESTORE!=="YES")throw Error("Restore blocked. Set CONFIRM_RESTORE=YES after verifying the backup.");
 if(!file)throw Error("Usage: CONFIRM_RESTORE=YES node scripts/restore.js ./backup.json");
 const data=JSON.parse(fs.readFileSync(file,"utf8"));
 if(data.app!=="MPPSC IQ"||data.format_version!==1||!data.tables)throw Error("Unsupported or invalid MPPSC IQ backup file");
 for(const t of baseTables)if(!Array.isArray(data.tables[t]))throw Error("Backup table missing or invalid: "+t);
 const tables=[...baseTables,...optionalTables.filter(t=>Array.isArray(data.tables[t]))];
 const deleteOrder=[...tables].reverse();
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  for(const t of deleteOrder)await c.query('DELETE FROM "'+t+'"');
  for(const t of tables){
   for(const row of data.tables[t]){
    const cols=Object.keys(row);
    if(!cols.length)continue;
    const sql='INSERT INTO "'+t+'" ('+cols.map(x=>'"'+x.replace(/"/g,'""')+'"').join(",")+') VALUES ('+cols.map((_,i)=>"$"+(i+1)).join(",")+')';
    await c.query(sql,cols.map(k=>row[k]));
   }
  }
  for(const t of serialTables.filter(t=>tables.includes(t))){
   const r=await c.query("SELECT pg_get_serial_sequence($1,'id') AS seq",[t]);
   if(r.rows[0]?.seq)await c.query("SELECT setval($1,COALESCE((SELECT MAX(id) FROM "+'"'+t+'"'+"),1),EXISTS(SELECT 1 FROM "+'"'+t+'"'+"))",[r.rows[0].seq]);
  }
  await c.query("COMMIT");
  console.log("RESTORE_OK",JSON.stringify(Object.fromEntries(tables.map(t=>[t,data.tables[t].length]))));
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
})().catch(e=>{console.error("RESTORE_FAILED:",e.message);process.exitCode=1;}).finally(async()=>{await pool.end();});
