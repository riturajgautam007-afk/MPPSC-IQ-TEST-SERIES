require("dotenv").config();
const express=require("express"),helmet=require("helmet"),bcrypt=require("bcryptjs"),multer=require("multer"),XLSX=require("xlsx"),path=require("node:path"),crypto=require("node:crypto"),{createClient}=require("@supabase/supabase-js");
const db=require("./db"),{verifyTelegramInitData,issueToken,requireAuth,requireAdmin}=require("./auth");
const membership=require("./membership");
const app=express(),port=process.env.PORT||3000,secret=process.env.JWT_SECRET;
function isTelegramAdmin(id){const ids=(process.env.ADMIN_TELEGRAM_IDS||process.env.ADMIN_TELEGRAM_ID||"").split(",").map(x=>x.trim()).filter(Boolean);return ids.includes(String(id));}
let dbReady=false,dbLastError="Database connection is not ready";
if(!secret||secret.length<32)throw new Error("JWT_SECRET must be at least 32 characters");
if(!process.env.DATABASE_URL||!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),bucket=process.env.SUPABASE_STORAGE_BUCKET||"mppsc-resources";
app.get("/.well-known/web-app-origin-association",(_q,s)=>s.type("application/json").send(JSON.stringify({"https://mppsc-iq-install.onrender.com":{scope:["/"]}})));
app.disable("x-powered-by");app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:"2mb"}));const allowedOrigins=new Set(["https://mppsc-iq-quiz-miniapp.onrender.com","https://mppsc-iq-student-miniapp.onrender.com","https://mppsc-iq-install.onrender.com","https://riturajgautam007-afk.github.io"]);app.use((req,res,next)=>{const origin=req.headers.origin;if(origin&&allowedOrigins.has(origin)){res.setHeader("Access-Control-Allow-Origin",origin);res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");res.setHeader("Access-Control-Allow-Methods","GET, POST, PUT, OPTIONS");res.setHeader("Access-Control-Allow-Credentials","true");}if(req.method==="OPTIONS")return res.sendStatus(204);next();});
// Keep the web app online even if the database is temporarily unreachable.
app.use("/api",(q,s,n)=>{if(q.path==="/health"||q.path==="/ready")return n();if(!dbReady)return s.status(503).json({error:"Database temporarily unavailable. Please try again shortly."});n();});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:(Number(process.env.MAX_UPLOAD_MB)||20)*1024*1024}});
const studentOnly=(q,s,n)=>q.auth.role==="student"?n():s.status(403).json({error:"Student only"});
const ar=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);
const requirePaid=membership.requirePaid(db);
membership.register(app,{db,requireAuth,requireAdmin,ar});
const OIDC_ISSUER="https://oauth.telegram.org",OIDC_REDIRECT=process.env.TELEGRAM_OIDC_REDIRECT_URI||"https://mppsc-iq-telegram-platform-mdri.onrender.com/api/auth/telegram/callback";
let telegramJwksCache=null,telegramJwksAt=0;
function b64u(v){return Buffer.from(v).toString("base64url");}
function sealState(data){const key=crypto.createHash("sha256").update(secret+"|telegram-oidc-state").digest(),iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",key,iv);const body=Buffer.concat([c.update(JSON.stringify({...data,iat:Date.now()})),c.final()]);return b64u(Buffer.concat([iv,c.getAuthTag(),body]));}
function openState(value){const raw=Buffer.from(String(value||""),"base64url");if(raw.length<29)throw Error("Invalid login state");const key=crypto.createHash("sha256").update(secret+"|telegram-oidc-state").digest(),iv=raw.subarray(0,12),tag=raw.subarray(12,28),body=raw.subarray(28),d=crypto.createDecipheriv("aes-256-gcm",key,iv);d.setAuthTag(tag);const data=JSON.parse(Buffer.concat([d.update(body),d.final()]).toString());if(!data.iat||Date.now()-data.iat>600000||Date.now()<data.iat-60000)throw Error("Login session expired; please try again");return data;}
async function getTelegramSigningKey(kid){if(!telegramJwksCache||Date.now()-telegramJwksAt>3600000){const r=await fetch(OIDC_ISSUER+"/.well-known/jwks.json",{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error("Could not load Telegram signing keys");telegramJwksCache=await r.json();telegramJwksAt=Date.now();}const jwk=(telegramJwksCache.keys||[]).find(k=>k.kid===kid&&k.use!=="enc");if(!jwk)throw Error("Telegram signing key not found");return crypto.createPublicKey({key:jwk,format:"jwk"});}
app.get("/api/health",(_q,s)=>s.json({ok:true,app:"MPPSC IQ",version:"2.2",database:dbReady?"connected":"disconnected",databaseMessage:dbReady?undefined:dbLastError}));
app.get("/api/ready",(_q,s)=>s.status(dbReady?200:503).json({ready:dbReady,database:dbReady?"connected":"disconnected"}));
app.get("/api/auth/telegram/start",(q,s)=>{if(!process.env.TELEGRAM_OIDC_CLIENT_ID||!process.env.TELEGRAM_OIDC_CLIENT_SECRET)return s.status(503).send("Telegram Login अभी configure नहीं है। Render Environment में TELEGRAM_OIDC_CLIENT_SECRET जोड़ें।");const mode=q.query.mode==="admin"?"admin":"student",nonce=crypto.randomBytes(24).toString("base64url"),verifier=crypto.randomBytes(48).toString("base64url"),challenge=b64u(crypto.createHash("sha256").update(verifier).digest()),state=sealState({nonce,verifier,mode});const u=new URL(OIDC_ISSUER+"/auth");u.searchParams.set("client_id",process.env.TELEGRAM_OIDC_CLIENT_ID);u.searchParams.set("redirect_uri",OIDC_REDIRECT);u.searchParams.set("response_type","code");u.searchParams.set("scope","openid profile");u.searchParams.set("state",state);u.searchParams.set("nonce",nonce);u.searchParams.set("code_challenge",challenge);u.searchParams.set("code_challenge_method","S256");s.redirect(302,u.toString());});
app.get("/api/auth/telegram/callback",ar(async(q,s)=>{if(q.query.error)return s.redirect("/?login=cancelled");const {nonce,verifier,mode="student"}=openState(q.query.state);if(!q.query.code||!nonce||!verifier)throw Error("Telegram authorization response incomplete");const credentials=Buffer.from(process.env.TELEGRAM_OIDC_CLIENT_ID+":"+process.env.TELEGRAM_OIDC_CLIENT_SECRET).toString("base64"),form=new URLSearchParams({grant_type:"authorization_code",code:String(q.query.code),redirect_uri:OIDC_REDIRECT,client_id:process.env.TELEGRAM_OIDC_CLIENT_ID,code_verifier:verifier});const tr=await fetch(OIDC_ISSUER+"/token",{method:"POST",headers:{Authorization:"Basic "+credentials,"Content-Type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(15000)}),tokens=await tr.json();if(!tr.ok||!tokens.id_token)throw Error("Telegram token exchange failed");const jwt=require("jsonwebtoken"),decoded=jwt.decode(tokens.id_token,{complete:true});if(!decoded||!decoded.header.kid||decoded.header.alg!=="RS256")throw Error("Unsupported Telegram ID token");const key=await getTelegramSigningKey(decoded.header.kid),claims=jwt.verify(tokens.id_token,key,{algorithms:["RS256"],issuer:OIDC_ISSUER,audience:process.env.TELEGRAM_OIDC_CLIENT_ID,clockTolerance:60});if(claims.nonce!==nonce)throw Error("Telegram login nonce mismatch");const telegramId=String(claims.id||claims.sub||"");if(!/^\d+$/.test(telegramId))throw Error("Telegram user ID missing");const adminUser=isTelegramAdmin(telegramId);if(mode==="admin"&&!adminUser)return s.redirect(302,"/?login=admin_required");const name=String(claims.name||[claims.given_name,claims.family_name].filter(Boolean).join(" ")||"Student").slice(0,160),username=String(claims.preferred_username||"").slice(0,64),r=await db.query("INSERT INTO students(telegram_id,name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username RETURNING id",[telegramId,name,username]),token=issueToken({sub:String(r.rows[0].id),role:(adminUser?"admin":"student")},secret);s.cookie("mppsc_iq_token",token,{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:7*24*60*60*1000});s.redirect(302,"/?login=success");}));
app.post("/api/auth/telegram",ar(async(q,s)=>{try{const u=verifyTelegramInitData(q.body?.initData,process.env.TELEGRAM_BOT_TOKEN),name=[u.first_name,u.last_name].filter(Boolean).join(" ")||"Student",r=await db.query("INSERT INTO students(telegram_id,name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username RETURNING id,name,username",[String(u.id),name,u.username||""]),st=r.rows[0];s.json({token:issueToken({sub:String(st.id),role:(isTelegramAdmin(u.id)?"admin":"student")},secret),user:st});}catch(e){s.status(401).json({error:e.message});}}));
app.post("/api/auth/admin",(_q,s)=>s.status(403).json({error:"Admin access केवल अधिकृत Telegram ID से लॉगिन करने पर मिलेगा।"}));
app.get("/api/auth/logout",(q,s)=>{s.clearCookie("mppsc_iq_token",{httpOnly:true,secure:true,sameSite:"lax",path:"/"});s.redirect(302,"/");});
app.get("/api/me",requireAuth,ar(async(q,s)=>{if(q.auth.role==="admin")return s.json({role:"admin"});const r=await db.query("SELECT id,name,username FROM students WHERE id=$1",[+q.auth.sub]);if(!r.rows[0])return s.status(401).json({error:"Student account not found"});s.json({...r.rows[0],role:"student"});}));
app.get("/api/tests",requireAuth,requirePaid,ar(async(q,s)=>{const r=await db.query("SELECT t.id,t.title,t.unit,t.duration_minutes,COUNT(q.id)::int question_count FROM tests t LEFT JOIN questions q ON q.test_id=t.id "+(q.auth.role==="admin"?"":"WHERE t.published=TRUE")+" GROUP BY t.id ORDER BY t.id DESC");s.json(r.rows);}));
app.post("/api/tests",requireAuth,requireAdmin,ar(async(q,s)=>{const {title,unit="",duration_minutes=60,published=false}=q.body||{};if(!title)return s.status(400).json({error:"Test title आवश्यक"});const r=await db.query("INSERT INTO tests(title,unit,duration_minutes,published) VALUES($1,$2,$3,$4) RETURNING id",[title,unit,Math.max(1,+duration_minutes||60),!!published]);s.json({id:r.rows[0].id});}));
app.post("/api/tests/:id/publish",requireAuth,requireAdmin,ar(async(q,s)=>{const r=await db.query("UPDATE tests SET published=NOT published WHERE id=$1 RETURNING published",( [ +q.params.id ] ));if(!r.rowCount)return s.status(404).json({error:"Test नहीं मिला"});s.json({published:r.rows[0].published});}));
app.delete("/api/tests/:id",requireAuth,requireAdmin,ar(async(q,s)=>{await db.query("DELETE FROM tests WHERE id=$1",[+q.params.id]);s.json({ok:true});}));
app.post("/api/tests/:id/questions",requireAuth,requireAdmin,ar(async(q,s)=>{const x=q.body||{};if(!x.question_hi||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>!v)||![0,1,2,3].includes(+x.correct_index))return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर दें"});const r=await db.query("INSERT INTO questions(test_id,question_hi,question_en,options_json,correct_index,explanation) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[+q.params.id,x.question_hi,x.question_en||"",JSON.stringify(x.options),+x.correct_index,x.explanation||""]);s.json({id:r.rows[0].id});}));
app.put("/api/questions/:id",requireAuth,requireAdmin,ar(async(q,s)=>{const x=q.body||{};if(!x.question_hi||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>!v)||![0,1,2,3].includes(+x.correct_index))return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर दें"});const r=await db.query("UPDATE questions SET question_hi=$1,question_en=$2,options_json=$3,correct_index=$4,explanation=$5 WHERE id=$6 RETURNING id",[x.question_hi,x.question_en||"",JSON.stringify(x.options),+x.correct_index,x.explanation||"",+q.params.id]);if(!r.rowCount)return s.status(404).json({error:"प्रश्न नहीं मिला"});s.json({ok:true});}));
app.delete("/api/questions/:id",requireAuth,requireAdmin,ar(async(q,s)=>{const r=await db.query("DELETE FROM questions WHERE id=$1 RETURNING id",[+q.params.id]);if(!r.rowCount)return s.status(404).json({error:"प्रश्न नहीं मिला"});s.json({ok:true});}));
app.get("/api/tests/:id/questions",requireAuth,requirePaid,ar(async(q,s)=>{const t=(await db.query("SELECT * FROM tests WHERE id=$1",[+q.params.id])).rows[0];if(!t||(!t.published&&q.auth.role!=="admin"))return s.status(404).json({error:"Test नहीं मिला"});const rows=(await db.query("SELECT id,question_hi,question_en,options_json,correct_index,explanation FROM questions WHERE test_id=$1 ORDER BY sort_order,id",[t.id])).rows;s.json({test:{id:t.id,title:t.title,unit:t.unit,duration_minutes:t.duration_minutes},questions:rows.map(x=>({id:x.id,question_hi:x.question_hi,question_en:x.question_en,options:x.options_json,correct_index:x.correct_index,explanation:x.explanation}))});}));
app.post("/api/tests/:id/submit",requireAuth,studentOnly,requirePaid,ar(async(q,s)=>{const t=(await db.query("SELECT * FROM tests WHERE id=$1 AND published=TRUE",[+q.params.id])).rows[0];if(!t)return s.status(404).json({error:"Test उपलब्ध नहीं"});const qs=(await db.query("SELECT id,correct_index FROM questions WHERE test_id=$1",[t.id])).rows,ans=q.body?.answers||{},sid=+q.auth.sub;let score=0;const c=await db.pool.connect();try{await c.query("BEGIN");for(const x of qs){if(+ans[x.id]===x.correct_index){score++;await c.query("DELETE FROM wrong_questions WHERE student_id=$1 AND question_id=$2",[sid,x.id]);}else await c.query("INSERT INTO wrong_questions(student_id,test_id,question_id,last_answer) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,question_id) DO UPDATE SET last_answer=EXCLUDED.last_answer",[sid,t.id,x.id,Number.isInteger(+ans[x.id])?+ans[x.id]:null]);}await c.query("INSERT INTO attempts(student_id,test_id,score,total,answers_json) VALUES($1,$2,$3,$4,$5)",[sid,t.id,score,qs.length,JSON.stringify(ans)]);await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}s.json({score,total:qs.length,percentage:qs.length?Math.round(score/qs.length*100):0});}));
app.get("/api/wrong-questions",requireAuth,studentOnly,requirePaid,ar(async(q,s)=>{const r=await db.query("SELECT w.id wrong_id,q.id,q.question_hi,q.question_en,q.options_json,q.correct_index,q.explanation,t.title test_title FROM wrong_questions w JOIN questions q ON q.id=w.question_id JOIN tests t ON t.id=w.test_id WHERE w.student_id=$1 ORDER BY w.id DESC",[+q.auth.sub]);s.json(r.rows.map(x=>({...x,options:x.options_json})));}));
app.post("/api/wrong-questions/:id/resolve",requireAuth,studentOnly,requirePaid,ar(async(q,s)=>{const x=(await db.query("SELECT w.id,q.correct_index FROM wrong_questions w JOIN questions q ON q.id=w.question_id WHERE w.id=$1 AND w.student_id=$2",[+q.params.id,+q.auth.sub])).rows[0];if(!x)return s.status(404).json({error:"प्रश्न नहीं मिला"});if(+q.body.answer!==x.correct_index)return s.json({correct:false});await db.query("DELETE FROM wrong_questions WHERE id=$1",[x.id]);s.json({correct:true});}));
app.get("/api/attempts/mine",requireAuth,studentOnly,requirePaid,ar(async(q,s)=>{const r=await db.query("SELECT a.id,a.score,a.total,a.created_at,t.title,t.unit FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.student_id=$1 ORDER BY a.id DESC",[+q.auth.sub]);s.json(r.rows);}));
app.get("/api/question-bank-overrides",requireAuth,requirePaid,ar(async(_q,s)=>{const [r,a]=await Promise.all([db.query("SELECT unit,question_index,question_json FROM question_bank_edits"),db.query("SELECT unit,question_json FROM question_bank_additions ORDER BY id")]);const edits={},additions={};for(const x of r.rows)edits[String(x.unit)+":"+String(x.question_index)]=x.question_json;for(const x of a.rows)(additions[String(x.unit)]??=[]).push(x.question_json);s.json({edits,additions});}));
app.get("/api/admin/question-bank",requireAuth,requireAdmin,ar(async(q,s)=>{const [counts,rows]=await Promise.all([db.query("SELECT unit,COUNT(*)::int count FROM question_bank_additions GROUP BY unit ORDER BY unit"),db.query("SELECT id,unit,question_json,created_at FROM question_bank_additions ORDER BY unit,id DESC LIMIT 500")]);const totals=Array.from({length:10},(_,i)=>({unit:i+1,count:0}));for(const x of counts.rows)totals[Number(x.unit)-1].count=x.count;s.json({units:totals,questions:rows.rows});}));
app.put("/api/admin/question-bank/additions/:id",requireAuth,requireAdmin,ar(async(q,s)=>{const x=q.body||{},id=Number(q.params.id);if(!Number.isInteger(id)||id<1)return s.status(400).json({error:"प्रश्न ID सही नहीं है"});if(typeof x.q!=="string"||!x.q.trim()||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>typeof v!=="string"||!v.trim())||!Number.isInteger(+x.answer)||+x.answer<0||+x.answer>3)return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर आवश्यक हैं"});const value={q:x.q.trim(),en:String(x.en||""),options:x.options.map(v=>String(v).trim()),answer:+x.answer,explanation:String(x.explanation||"")};const r=await db.query("UPDATE question_bank_additions SET question_json=$1 WHERE id=$2 RETURNING id",[JSON.stringify(value),id]);if(!r.rowCount)return s.status(404).json({error:"प्रश्न नहीं मिला"});s.json({ok:true});}));
app.delete("/api/admin/question-bank/additions/:id",requireAuth,requireAdmin,ar(async(q,s)=>{const r=await db.query("DELETE FROM question_bank_additions WHERE id=$1 RETURNING id",[Number(q.params.id)]);if(!r.rowCount)return s.status(404).json({error:"प्रश्न नहीं मिला"});s.json({ok:true});}));
app.post("/api/admin/question-bank/:unit/append",requireAuth,requireAdmin,ar(async(q,s)=>{const unit=Number(q.params.unit),items=q.body?.questions;if(!Number.isInteger(unit)||unit<1||unit>10)return s.status(400).json({error:"Unit 1 से 10 चुनें"});if(!Array.isArray(items)||!items.length||items.length>1000)return s.status(400).json({error:"कम से कम एक और अधिकतम 1000 प्रश्न भेजें"});const clean=[];for(let i=0;i<items.length;i++){const x=items[i]||{},opts=x.options;if(typeof x.question_hi!=="string"||!x.question_hi.trim()||!Array.isArray(opts)||opts.length!==4||opts.some(v=>typeof v!=="string"||!v.trim())||!Number.isInteger(Number(x.correct_index))||Number(x.correct_index)<0||Number(x.correct_index)>3)return s.status(400).json({error:"प्रश्न "+(i+1)+" में प्रश्न, चार विकल्प और सही उत्तर जाँचें"});clean.push({q:x.question_hi.trim(),en:String(x.question_en||""),options:opts.map(v=>v.trim()),answer:Number(x.correct_index),explanation:String(x.explanation||"")});}const norm=v=>String(v||"").normalize("NFKC").toLocaleLowerCase("hi").replace(/[\s\p{P}]+/gu," ").trim();const existing=(await db.query("SELECT question_json FROM question_bank_additions WHERE unit=$1",[unit])).rows.map(x=>norm(x.question_json?.q));const seen=new Set(existing),fresh=[],duplicates=[];for(let i=0;i<clean.length;i++){const key=norm(clean[i].q);if(seen.has(key)){duplicates.push(i+1);continue;}seen.add(key);fresh.push(clean[i]);}const c=await db.pool.connect();try{await c.query("BEGIN");for(const item of fresh)await c.query("INSERT INTO question_bank_additions(unit,question_json) VALUES($1,$2)",[unit,JSON.stringify(item)]);await c.query("COMMIT");s.json({ok:true,unit,imported:fresh.length,skipped:duplicates.length,duplicateRows:duplicates});}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}));
app.put("/api/admin/question-bank/:unit/:index",requireAuth,requireAdmin,ar(async(q,s)=>{const unit=Number(q.params.unit),index=Number(q.params.index),x=q.body||{};if(!Number.isInteger(unit)||unit<1||unit>10||!Number.isInteger(index)||index<0||index>10000)return s.status(400).json({error:"यूनिट या प्रश्न क्रमांक सही नहीं है"});if(typeof x.q!=="string"||!x.q.trim()||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>typeof v!=="string"||!v.trim())||!Number.isInteger(+x.answer)||+x.answer<0||+x.answer>3)return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर आवश्यक हैं"});const value={q:x.q.trim(),en:String(x.en||""),options:x.options.map(v=>String(v).trim()),answer:+x.answer,explanation:String(x.explanation||"")};await db.query("INSERT INTO question_bank_edits(unit,question_index,question_json,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(unit,question_index) DO UPDATE SET question_json=EXCLUDED.question_json,updated_at=NOW()",[unit,index,JSON.stringify(value)]);s.json({ok:true,unit,index});}));
app.get("/api/admin/backup",requireAuth,requireAdmin,ar(async(_q,res)=>{
 const tables=["students","tests","questions","attempts","wrong_questions","resources","question_bank_edits","question_bank_additions","student_memberships","membership_payment_requests"];
 const backup={app:"MPPSC IQ",format_version:1,created_at:new Date().toISOString(),tables:{}};
 for(const table of tables){
  const result=await db.query("SELECT * FROM "+table+" ORDER BY 1");
  backup.tables[table]=result.rows;
 }
 res.setHeader("Content-Type","application/json; charset=utf-8");
 res.setHeader("Content-Disposition",'attachment; filename="mppsc-iq-backup-'+new Date().toISOString().slice(0,10)+'.json"');
 res.send(JSON.stringify(backup));
}));
app.get("/api/admin/overview",requireAuth,requireAdmin,ar(async(_q,s)=>{const r=await db.query("SELECT (SELECT COUNT(*) FROM students)::int students,(SELECT COUNT(*) FROM tests)::int tests,(SELECT COUNT(*) FROM questions)::int questions,(SELECT COUNT(*) FROM attempts)::int attempts");s.json(r.rows[0]);}));
app.get("/api/admin/analytics",requireAuth,requireAdmin,ar(async(_q,s)=>{const r=await db.query("SELECT st.id,st.name,st.username,st.telegram_id,COUNT(at.id)::int attempts,COALESCE(SUM(at.score),0)::int total_correct,COALESCE(SUM(at.total),0)::int total_questions,CASE WHEN SUM(at.total)>0 THEN ROUND(100.0*SUM(at.score)/SUM(at.total),1) ELSE 0 END average_percentage,MAX(at.created_at) last_attempt FROM students st LEFT JOIN attempts at ON at.student_id=st.id GROUP BY st.id ORDER BY attempts DESC,average_percentage DESC,st.id DESC");s.json(r.rows);}));
app.get("/api/admin/students",requireAuth,requireAdmin,ar(async(_q,s)=>{const r=await db.query("SELECT id,name,telegram_id,username,created_at FROM students ORDER BY id DESC");s.json(r.rows);}));
app.post("/api/tests/:id/import-text",requireAuth,requireAdmin,ar(async(q,s)=>{
 const raw=String(q.body?.text||"").replace(/\r\n?/g,"\n").trim();
 if(!raw)return s.status(400).json({error:"प्रश्नों का Text Paste करें"});
 if(raw.length>1500000)return s.status(413).json({error:"Text बहुत बड़ा है। इसे छोटे भागों में Import करें।"});
 const clean=raw.replace(/\*\*/g,"");
 const blocks=clean.split(/(?=^\s*(?:प्रश्न|Question)\s*\d+\s*[.):])/mi).map(x=>x.trim()).filter(Boolean);
 const parsed=[],bad=[];
 for(let i=0;i<blocks.length;i++){
  const block=blocks[i].replace(/^\s*(?:प्रश्न|Question)\s*\d+\s*[.):]\s*/i,"").trim();
  const ansRe=/(?:उत्तर|सही\s*उत्तर|Answer|Correct\s*Answer)\s*[:：\-]?\s*\(?\s*([A-D])\s*\)?/i;
  const ans=ansRe.exec(block);
  if(!ans){bad.push({number:i+1,reason:"उत्तर: (A/B/C/D) नहीं मिला"});continue;}
  const optionArea=block.slice(0,ans.index);
  const optionRe=/\(\s*([A-D])\s*\)\s*/gi;
  const marks=[...optionArea.matchAll(optionRe)];
  const question=(marks.length?optionArea.slice(0,marks[0].index):"").trim();
  const options=["A","B","C","D"].map(letter=>{
   const m=marks.find(x=>x[1].toUpperCase()===letter);
   if(!m)return "";
   const next=marks.find(x=>x.index>m.index);
   return optionArea.slice(m.index+m[0].length,next?next.index:optionArea.length).replace(/\s+/g," ").trim();
  });
  const explanation=block.slice(ans.index+ans[0].length).replace(/^\s*(?:व्याख्या|Explanation)?\s*[:：\-]?\s*/i,"").trim().replace(/\*+$/,"").trim();
  if(!question||options.some(x=>!x)||marks.length!==4){bad.push({number:i+1,reason:"प्रश्न और (A), (B), (C), (D) के चारों विकल्प स्पष्ट नहीं मिले"});continue;}
  parsed.push({question,options,answer:ans[1].toUpperCase().charCodeAt(0)-65,explanation});
 }
 if(!parsed.length)return s.status(400).json({error:"कोई वैध प्रश्न नहीं मिला। प्रश्न 1., (A), (B), (C), (D), उत्तर: (B) वाला Format रखें।",skipped:bad});
 const testId=Number(q.params.id);
 const c=await db.pool.connect();let startOrder=0;
 try{
  await c.query("BEGIN");
  const test=await c.query("SELECT id FROM tests WHERE id=$1 FOR UPDATE",[testId]);
  if(!test.rowCount){await c.query("ROLLBACK");return s.status(404).json({error:"चुना हुआ Unit/Test नहीं मिला"});}
  const mx=await c.query("SELECT COALESCE(MAX(sort_order),0)::int AS n FROM questions WHERE test_id=$1",[testId]);startOrder=mx.rows[0].n;
  for(let i=0;i<parsed.length;i++){const x=parsed[i];await c.query("INSERT INTO questions(test_id,question_hi,question_en,options_json,correct_index,explanation,sort_order) VALUES($1,$2,'',$3,$4,$5,$6)",[testId,x.question,JSON.stringify(x.options),x.answer,x.explanation,startOrder+i+1]);}
  const total=await c.query("SELECT COUNT(*)::int AS n FROM questions WHERE test_id=$1",[testId]);
  await c.query("COMMIT");
  s.json({imported:parsed.length,skipped:bad.length,total:total.rows[0].n,skippedDetails:bad.slice(0,30)});
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}));
app.post("/api/tests/:id/import-bulk",requireAuth,requireAdmin,ar(async(q,s)=>{
 const testId=Number(q.params.id),items=q.body?.questions;
 if(!Number.isInteger(testId)||testId<1)return s.status(400).json({error:"टेस्ट ID सही नहीं है"});
 if(!Array.isArray(items)||!items.length||items.length>1000)return s.status(400).json({error:"1 से 1000 वैध प्रश्न भेजें"});
 const c=await db.pool.connect();let imported=0,duplicates=0,skipped=0;
 const norm=v=>String(v||"").normalize("NFKC").toLocaleLowerCase("hi").replace(/[\\s\\p{P}]+/gu," ").trim();
 try{await c.query("BEGIN");const test=await c.query("SELECT id FROM tests WHERE id=$1 FOR UPDATE",[testId]);if(!test.rowCount){await c.query("ROLLBACK");return s.status(404).json({error:"चुना हुआ टेस्ट नहीं मिला"});}const existing=await c.query("SELECT question_hi FROM questions WHERE test_id=$1",[testId]);const seen=new Set(existing.rows.map(x=>norm(x.question_hi)));const max=await c.query("SELECT COALESCE(MAX(sort_order),0)::int n FROM questions WHERE test_id=$1",[testId]);let order=max.rows[0].n;
 for(const x of items){if(!x||typeof x.question_hi!=="string"||!x.question_hi.trim()||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>typeof v!=="string"||!v.trim())||!Number.isInteger(Number(x.correct_index))||Number(x.correct_index)<0||Number(x.correct_index)>3){skipped++;continue;}const key=norm(x.question_hi);if(seen.has(key)){duplicates++;continue;}seen.add(key);order++;await c.query("INSERT INTO questions(test_id,question_hi,question_en,options_json,correct_index,explanation,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)",[testId,x.question_hi.trim(),String(x.question_en||""),JSON.stringify(x.options.map(v=>String(v).trim())),Number(x.correct_index),String(x.explanation||""),order]);imported++;}
 await c.query("COMMIT");s.json({ok:true,imported,duplicates,skipped,total:items.length});
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}));
app.post("/api/tests/:id/import-xlsx",requireAuth,requireAdmin,upload.single("file"),ar(async(q,s)=>{if(!q.file)return s.status(400).json({error:"Excel फाइल चुनें"});const wb=XLSX.read(q.file.buffer,{type:"buffer"}),rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}),pick=(r,keys)=>{const k=Object.keys(r).find(x=>keys.includes(x.trim().toLowerCase()));return k?r[k]:"";},map={A:0,B:1,C:2,D:3,"1":0,"2":1,"3":2,"4":3};let imported=0,skipped=0;const c=await db.pool.connect();try{await c.query("BEGIN");for(let i=0;i<rows.length;i++){const r=rows[i],qh=String(pick(r,["question_hi","question","प्रश्न"])||"").trim(),opts=["a","b","c","d"].map(k=>String(pick(r,[k,"option_"+k])||"").trim()),a=map[String(pick(r,["answer","correct_answer","उत्तर"])||"").trim().toUpperCase()];if(!qh||opts.some(x=>!x)||a===undefined){skipped++;continue;}await c.query("INSERT INTO questions(test_id,question_hi,question_en,options_json,correct_index,explanation,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)",[+q.params.id,qh,String(pick(r,["question_en"])||""),JSON.stringify(opts),a,String(pick(r,["explanation","व्याख्या"])||""),i]);imported++;}await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}s.json({imported,skipped,total:rows.length});}));
app.get("/api/resources",requireAuth,requirePaid,ar(async(_q,s)=>{const r=await db.query("SELECT id,title,unit,file_path,created_at FROM resources ORDER BY id DESC");s.json(r.rows);}));
app.post("/api/resources",requireAuth,requireAdmin,upload.single("file"),ar(async(q,s)=>{if(!q.file)return s.status(400).json({error:"PDF/file चुनें"});const filename=Date.now()+"-"+path.basename(q.file.originalname).replace(/[^\\w.-]/g,"_"),{error}=await supabase.storage.from(bucket).upload(filename,q.file.buffer,{contentType:q.file.mimetype||"application/octet-stream",upsert:false});if(error)throw error;const r=await db.query("INSERT INTO resources(title,unit,file_path) VALUES($1,$2,$3) RETURNING id",[q.body.title||q.file.originalname,q.body.unit||"",filename]);s.json({id:r.rows[0].id});}));
app.get("/uploads/:file",requireAuth,requirePaid,ar(async(q,s)=>{const {data,error}=await supabase.storage.from(bucket).createSignedUrl(q.params.file,300);if(error)return s.status(404).json({error:"File नहीं मिली"});s.redirect(data.signedUrl);}));
// PWA app-shell headers: keep the existing quiz HTML and UI unchanged.
app.get("/",(q,s,n)=>{
  // Resolve authenticated role on the server before rendering the login gate.
  let session=null;
  try{
    const cookies=Object.fromEntries((q.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));
    if(cookies.mppsc_iq_token) session=require("jsonwebtoken").verify(cookies.mppsc_iq_token,secret,{issuer:"mppsc-iq"});
  }catch(_e){}
  const file=path.join(__dirname,"..","public","index.html");
  require("node:fs").readFile(file,"utf8",(err,html)=>{
    if(err)return n(err);
    const head='<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0b203d"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="MPPSC IQ"><link rel="apple-touch-icon" href="/icons/mppsc-iq.svg"><meta name="mobile-web-app-capable" content="yes"><script src="https://telegram.org/js/telegram-web-app.js"></script><script>try{const w=window.Telegram&&window.Telegram.WebApp;if(w){w.ready();w.expand();try{w.setHeaderColor("#0b203d");w.setBackgroundColor("#ffffff")}catch(e){}document.documentElement.classList.add("telegram-mini-app");window.MPPSC_IQ_TELEGRAM=true;window.MPPSC_IQ_TG_USER=w.initDataUnsafe&&w.initDataUnsafe.user||null;}}catch(e){console.warn("Telegram Mini App initialization:",e)}</script>';
    const boot='<script>if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));}</script>';
    let page=html;
    if(!/rel=["']manifest["']/.test(page)) page=page.replace(/<head[^>]*>/i,m=>m+head);
    if(!page.includes('navigator.serviceWorker.register("/sw.js")')) page=page.replace(/<\/body>/i,boot+"</body>");
    const loginGate=`<style id="studentLoginGateStyle">
body:not(.iq-authenticated)>:not(#studentLoginGate):not(#adminInsideApp){visibility:hidden!important}
:root{--iq-navy:#102744;--iq-blue:#1f4e7d;--iq-gold:#e7bd62;--iq-bg:#f4f7fb;--iq-ink:#17263d;--iq-muted:#718096}
#studentLoginGate{position:fixed;inset:0;z-index:2147483000;background:var(--iq-bg);display:flex;align-items:center;justify-content:center;padding:18px;font-family:system-ui,"Noto Sans Devanagari",sans-serif;color:var(--iq-ink);overflow:auto}
#studentLoginGate .gatecard{width:100%;max-width:560px;background:#fff;border:1px solid #e4eaf2;border-radius:24px;overflow:hidden;box-shadow:0 18px 55px #142b4818}
#studentLoginGate .hero{background:linear-gradient(145deg,#102744,#24578a);color:#fff;padding:34px 24px 30px;text-align:center}
#studentLoginGate .gatebrand{font-size:32px;font-weight:950;letter-spacing:.4px;color:#fff}
#studentLoginGate .gatebrand span{color:var(--iq-gold)}
#studentLoginGate .brandtag{font-size:10px;letter-spacing:2px;color:#d8e2ef;margin-top:4px}
#studentLoginGate .hero h2{font-size:23px;line-height:1.35;color:#fff;margin:22px 0 6px}
#studentLoginGate .hero p{color:#dce7f4;margin:0;line-height:1.6;font-size:14px}
#studentLoginGate .homebody{padding:24px}
#studentLoginGate .loginchoices{display:grid;grid-template-columns:1fr 1fr;gap:12px}
#studentLoginGate .loginlink{display:flex;align-items:center;justify-content:center;min-height:58px;box-sizing:border-box;text-align:center;text-decoration:none;background:linear-gradient(100deg,#e8c36e,#f1d895);color:#102744;padding:14px 10px;border:0;border-radius:14px;font-weight:900;font-size:15px;box-shadow:0 6px 16px #c49a3d30}
#studentLoginGate .loginlink.admin{background:linear-gradient(135deg,#173b63,#24578a);color:#fff;border:1px solid #6e91b8;box-shadow:0 6px 16px #173b6330}
#studentLoginGate .welcome{font-size:19px;font-weight:900;color:#173452;text-align:center;margin:0 0 16px}
#studentLoginGate .actionbtn{display:flex;align-items:center;justify-content:center;width:100%;min-height:58px;box-sizing:border-box;border:0;border-radius:14px;padding:14px;font-size:16px;font-weight:900;cursor:pointer;text-decoration:none}
#studentLoginGate .revision{background:linear-gradient(100deg,#16845b,#0d6b4d);color:#fff}
#studentLoginGate .adminpanel{background:linear-gradient(135deg,#e8c36e,#f1d895);color:#102744;margin-bottom:10px}
#studentLoginGate .footnote{display:block;text-align:center;color:#8a97a8;font-size:11px;margin:18px 0 0}
#studentHomePanel{display:none}
#adminInsideApp{display:none;position:fixed;inset:0;z-index:2147483600;background:#fff}
#adminInsideApp iframe{width:100%;height:100%;border:0}
#adminInsideApp .closeAdmin{position:absolute;right:12px;top:10px;z-index:3;background:#e4bd55;border:0;border-radius:10px;padding:9px 14px;font-weight:900;box-shadow:0 2px 10px #0003}
@media(max-width:420px){#studentLoginGate{padding:0}#studentLoginGate .gatecard{min-height:100%;border-radius:0;display:flex;flex-direction:column;justify-content:center}#studentLoginGate .hero{padding:38px 20px 32px}#studentLoginGate .homebody{padding:22px 18px}#studentLoginGate .loginchoices{grid-template-columns:1fr;gap:10px}}
</style>
<section id="studentLoginGate"><div class="gatecard">
<header class="hero"><div class="gatebrand">MPPSC <span>IQ</span></div><div class="brandtag">MPPSC PRE 2027 PROGRAM</div><h2 id="gateHeading">आपका स्वागत है</h2><p id="gateSubheading">आगे बढ़ने के लिए अपना Login चुनें।</p></header>
<div class="homebody">
<div class="loginchoices" id="loginChoices">
<a class="loginlink" href="/api/auth/telegram/start?mode=student">🎓 Student Login</a>
<a class="loginlink admin" href="/api/auth/telegram/start?mode=admin">🔐 Admin Login</a>
</div>
<section id="studentHomePanel">
<div class="welcome" id="studentWelcome">नमस्ते</div>
<button type="button" class="actionbtn revision" onclick="location.href='/app'">📚 रिवीजन शुरू करें</button>
<button type="button" class="actionbtn adminpanel" id="adminPanelButton" style="display:none" onclick="document.getElementById('adminInsideApp').style.display='block';document.getElementById('adminInsideFrame').src='/admin.html'">⚙️ Admin Panel खोलें</button>
<div class="footnote">नियमित अभ्यास • सही विश्लेषण • बेहतर परिणाम</div>
</section>
<small class="footnote" id="gateFootnote">सुरक्षित लॉगिन के बाद ही रिवीजन और Admin Panel उपलब्ध होंगे।</small>
</div></div></section>
<section id="adminInsideApp"><button class="closeAdmin" type="button" onclick="document.getElementById('adminInsideApp').style.display='none';document.getElementById('adminInsideFrame').src='about:blank'">✕ वापस ऐप पर</button><iframe id="adminInsideFrame" title="MPPSC IQ Admin"></iframe></section>
<script>(async()=>{try{const r=await fetch('/api/me',{credentials:'same-origin'});if(!r.ok)return;const u=await r.json();if(u.role!=='student'&&u.role!=='admin')return;document.getElementById('loginChoices').style.display='none';document.getElementById('gateHeading').textContent='आपका स्वागत है';document.getElementById('gateSubheading').textContent=u.role==='admin'?'Admin Panel या Revision चुनें।':'आप लॉगिन हो चुके हैं। अब रिवीजन शुरू करें।';document.getElementById('studentHomePanel').style.display='block';document.getElementById('gateFootnote').style.display='none';const n=(u.name||(u.role==='admin'?'Admin':'विद्यार्थी')).trim();document.getElementById('studentWelcome').textContent=u.role==='admin'?'नमस्ते, Admin':'नमस्ते, '+n;if(u.role==='admin')document.getElementById('adminPanelButton').style.display='flex';}catch(e){console.warn('Student dashboard data unavailable',e);}})();</script>`;
    if(!page.includes('id="studentLoginGate"')) page=page.replace(/<body([^>]*)>/i,'<body$1>'+loginGate);
    s.type("html").send(page);
  });
});
app.get("/app",requireAuth,(q,s)=>s.sendFile(path.join(__dirname,"..","public","index.html")));
// Protect the admin HTML shell itself; API routes remain independently protected.
app.get("/admin.html",(q,s,n)=>{
 requireAuth(q,s,()=>{
  if(q.auth?.role!=="admin")return s.status(403).send("Admin access केवल अधिकृत Admin के लिए है।");
  s.sendFile(path.join(__dirname,"..","public","admin.html"));
 });
});
app.use(express.static(path.join(__dirname,"..","public")));app.get("*",(_q,s)=>s.sendFile(path.join(__dirname,"..","public","index.html")));
app.use((e,_q,s,_n)=>{console.error(e);s.status(400).json({error:e.message||"Request failed"});});
async function connectDatabase(){try{await db.init();await membership.ensureSchema(db);dbReady=true;dbLastError="";console.log("Database connected and schema ready");const {error}=await supabase.storage.createBucket(bucket,{public:false,fileSizeLimit:(Number(process.env.MAX_UPLOAD_MB)||20)*1024*1024});if(error&&!String(error.message).toLowerCase().includes("already"))console.warn("Storage bucket setup:",error.message);}catch(e){dbReady=false;dbLastError=e.message||"Database connection failed";console.error("Database unavailable; web server remains online:",dbLastError);}}
app.listen(port,()=>console.log("MPPSC IQ server listening on "+port));
connectDatabase();
setInterval(()=>{if(!dbReady)connectDatabase();},30000).unref();