"use strict";
require("dotenv").config();
const {Pool}=require("pg");
const {createClient}=require("@supabase/supabase-js");
const dns=require("node:dns");dns.setDefaultResultOrder("ipv4first");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:15000});
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const bucket=process.env.SUPABASE_STORAGE_BUCKET||"mppsc-resources";
const tables=["students","tests","questions","attempts","wrong_questions","resources","question_bank_edits","question_bank_additions","student_memberships","membership_payment_requests"];
const keepDays=Math.max(7,Number(process.env.BACKUP_RETENTION_DAYS)||30);
(async()=>{
 if(!process.env.DATABASE_URL||!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw Error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
 const backup={app:"MPPSC IQ",format_version:1,created_at:new Date().toISOString(),tables:{}};
 for(const table of tables){const r=await pool.query('SELECT * FROM "'+table+'" ORDER BY 1');backup.tables[table]=r.rows;}
 const bytes=Buffer.from(JSON.stringify(backup));
 const name="daily/"+new Date().toISOString().replace(/[:.]/g,"-")+".json";
 const {error}=await supabase.storage.from(bucket).upload(name,bytes,{contentType:"application/json",upsert:false});
 if(error)throw error;
 const cutoff=Date.now()-keepDays*86400000;
 const {data:files,error:listError}=await supabase.storage.from(bucket).list("daily",{limit:1000,sortBy:{column:"name",order:"asc"}});
 if(listError)throw listError;
 const expired=(files||[]).filter(x=>x.name.endsWith(".json")&&x.created_at&&Date.parse(x.created_at)<cutoff).map(x=>"daily/"+x.name);
 if(expired.length){const {error:removeError}=await supabase.storage.from(bucket).remove(expired);if(removeError)throw removeError;}
 process.stdout.write(JSON.stringify({ok:true,object:name,bytes:bytes.length,retention_days:keepDays,deleted_old:expired.length})+"\\n");
})().catch(e=>{console.error("BACKUP_FAILED:",e.message);process.exitCode=1;}).finally(async()=>{await pool.end();});
