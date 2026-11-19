require("dotenv").config();
const express=require("express"),helmet=require("helmet"),bcrypt=require("bcryptjs"),multer=require("multer"),XLSX=require("xlsx"),path=require("node:path"),crypto=require("node:crypto"),{createClient}=require("@supabase/supabase-js");
const db=require("./db"),{verifyTelegramInitData,issueToken,requireAuth,requireAdmin}=require("./auth");
const app=express(),port=process.env.PORT||3000,secret=process.env.JWT_SECRET;
let dbReady=false,dbLastError="Database connection is not ready";
if(!secret||secret.length<32)throw new Error("JWT_SECRET must be at least 32 characters");
if(!process.env.DATABASE_URL||!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),bucket=process.env.SUPABASE_STORAGE_BUCKET||"mppsc-resources";
app.disable("x-powered-by");app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:"2mb"}));
// Keep the web app online even if the database is temporarily unreachable.
app.use("/api",(q,s,n)=>{if(q.path==="/health"||q.path==="/ready")return n();if(!dbReady)return s.status(503).json({error:"Database temporarily unavailable. Please try again shortly."});n();});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:(Number(process.env.MAX_UPLOAD_MB)||20)*1024*1024}});
const studentOnly=(q,s,n)=>q.auth.role==="student"?n():s.status(403).json({error:"Student only"});
const ar=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);
const OIDC_ISSUER="https://oauth.telegram.org",OIDC_REDIRECT=process.env.TELEGRAM_OIDC_REDIRECT_URI||"https://mppsc-iq-telegram-platform-mdri.onrender.com/api/auth/telegram/callback";
let telegramJwksCache=null,telegramJwksAt=0;
function b64u(v){return Buffer.from(v).toString("base64url");}
function sealState(data){const key=crypto.createHash("sha256").update(secret+"|telegram-oidc-state").digest(),iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",key,iv);const body=Buffer.concat([c.update(JSON.stringify({...data,iat:Date.now()})),c.final()]);return b64u(Buffer.concat([iv,c.getAuthTag(),body]));}
function openState(value){const raw=Buffer.from(String(value||""),"base64url");if(raw.length<29)throw Error("Invalid login state");const key=crypto.createHash("sha256").update(secret+"|telegram-oidc-state").digest(),iv=raw.subarray(0,12),tag=raw.subarray(12,28),body=raw.subarray(28),d=crypto.createDecipheriv("aes-256-gcm",key,iv);d.setAuthTag(tag);const data=JSON.parse(Buffer.concat([d.update(body),d.final()]).toString());if(!data.iat||Date.now()-data.iat>600000||Date.now()<data.iat-60000)throw Error("Login session expired; please try again");return data;}
async function getTelegramSigningKey(kid){if(!telegramJwksCache||Date.now()-telegramJwksAt>3600000){const r=await fetch(OIDC_ISSUER+"/.well-known/jwks.json",{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error("Could not load Telegram signing keys");telegramJwksCache=await r.json();telegramJwksAt=Date.now();}const jwk=(telegramJwksCache.keys||[]).find(k=>k.kid===kid&&k.use!=="enc");if(!jwk)throw Error("Telegram signing key not found");return crypto.createPublicKey({key:jwk,format:"jwk"});}
app.get("/api/health",(_q,s)=>s.json({ok:true,app:"MPPSC IQ",version:"2.2",database:dbReady?"connected":"disconnected",databaseMessage:dbReady?undefined:dbLastError}));
app.get("/api/ready",(_q,s)=>s.status(dbReady?200:503).json({ready:dbReady,database:dbReady?"connected":"disconnected"}));
app.get("/api/auth/telegram/start",(q,s)=>{if(!process.env.TELEGRAM_OIDC_CLIENT_ID||!process.env.TELEGRAM_OIDC_CLIENT_SECRET)return s.status(503).send("Telegram Login अभी configure नहीं है। Render Environment में TELEGRAM_OIDC_CLIENT_SECRET जोड़ें।");const nonce=crypto.randomBytes(24).toString("base64url"),verifier=crypto.randomBytes(48).toString("base64url"),challenge=b64u(crypto.createHash("sha256").update(verifier).digest()),state=sealState({nonce,verifier});const u=new URL(OIDC_ISSUER+"/auth");u.searchParams.set("client_id",process.env.TELEGRAM_OIDC_CLIENT_ID);u.searchParams.set("redirect_uri",OIDC_REDIRECT);u.searchParams.set("response_type","code");u.searchParams.set("scope","openid profile");u.searchParams.set("state",state);u.searchParams.set("nonce",nonce);u.searchParams.set("code_challenge",challenge);u.searchParams.set("code_challenge_method","S256");s.redirect(302,u.toString());});
app.get("/api/auth/telegram/callback",ar(async(q,s)=>{if(q.query.error)return s.redirect("/?login=cancelled");const {nonce,verifier}=openState(q.query.state);if(!q.query.code||!nonce||!verifier)throw Error("Telegram authorization response incomplete");const credentials=Buffer.from(process.env.TELEGRAM_OIDC_CLIENT_ID+":"+process.env.TELEGRAM_OIDC_CLIENT_SECRET).toString("base64"),form=new URLSearchParams({grant_type:"authorization_code",code:String(q.query.code),redirect_uri:OIDC_REDIRECT,client_id:process.env.TELEGRAM_OIDC_CLIENT_ID,code_verifier:verifier});const tr=await fetch(OIDC_ISSUER+"/token",{method:"POST",headers:{Authorization:"Basic "+credentials,"Content-Type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(15000)}),tokens=await tr.json();if(!tr.ok||!tokens.id_token)throw Error("Telegram token exchange failed");const jwt=require("jsonwebtoken"),decoded=jwt.decode(tokens.id_token,{complete:true});if(!decoded||!decoded.header.kid||decoded.header.alg!=="RS256")throw Error("Unsupported Telegram ID token");const key=await getTelegramSigningKey(decoded.header.kid),claims=jwt.verify(tokens.id_token,key,{algorithms:["RS256"],issuer:OIDC_ISSUER,audience:process.env.TELEGRAM_OIDC_CLIENT_ID,clockTolerance:60});if(claims.nonce!==nonce)throw Error("Telegram login nonce mismatch");const telegramId=String(claims.id||claims.sub||"");if(!/^\d+$/.test(telegramId))throw Error("Telegram user ID missing");const name=String(claims.name||[claims.given_name,claims.family_name].filter(Boolean).join(" ")||"Student").slice(0,160),username=String(claims.preferred_username||"").slice(0,64),r=await db.query("INSERT INTO students(telegram_id,name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username RETURNING id",[telegramId,name,username]),token=issueToken({sub:String(r.rows[0].id),role:(String(telegramId)===String(process.env.ADMIN_TELEGRAM_ID||"")?"admin":"student")},secret);s.cookie("mppsc_iq_token",token,{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:7*24*60*60*1000});s.redirect(302,"/?login=success");}));
app.post("/api/auth/telegram",ar(async(q,s)=>{try{const u=verifyTelegramInitData(q.body?.initData,process.env.TELEGRAM_BOT_TOKEN),name=[u.first_name,u.last_name].filter(Boolean).join(" ")||"Student",r=await db.query("INSERT INTO students(telegram_id,name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username RETURNING id,name,username",[String(u.id),name,u.username||""]),st=r.rows[0];s.json({token:issueToken({sub:String(st.id),role:(String(u.id)===String(process.env.ADMIN_TELEGRAM_ID||"")?"admin":"student")},secret),user:st});}catch(e){s.status(401).json({error:e.message});}}));
app.post("/api/auth/admin",ar(async(q,s)=>{const password=String(q.body?.password||""),hash=process.env.ADMIN_PASSWORD_HASH,plain=process.env.ADMIN_PASSWORD;const passwordOk=plain?password===plain:(hash?await bcrypt.compare(password,hash):false);const ok=q.body?.username===(process.env.ADMIN_USERNAME||"admin")&&passwordOk;if(!ok)return s.status(401).json({error:"गलत Admin ID या Password"});const token=issueToken({sub:"admin",role:"admin"},secret);s.setHeader("Set-Cookie","mppsc_iq_token="+encodeURIComponent(token)+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800");s.json({token});}));
app.get("/api/me",requireAuth,ar(async(q,s)=>{if(q.auth.role==="admin")return s.json({role:"admin"});const r=await db.query("SELECT id,name,username FROM students WHERE id=$1",[+q.auth.sub]);if(!r.rows[0])return s.status(401).json({error:"Student account not found"});s.json({...r.rows[0],role:"student"});}));
app.get("/api/tests",requireAuth,ar(async(q,s)=>{const r=await db.query("SELECT t.id,t.title,t.unit,t.duration_minutes,COUNT(q.id)::int question_count FROM tests t LEFT JOIN questions q ON q.test_id=t.id "+(q.auth.role==="admin"?"":"WHERE t.published=TRUE")+" GROUP BY t.id ORDER BY t.id DESC");s.json(r.rows);}));
app.post("/api/tests",requireAuth,requireAdmin,ar(async(q,s)=>{const {title,unit="",duration_minutes=60,published=false}=q.body||{};if(!title)return s.status(400).json({error:"Test title आवश्यक"});const r=await db.query("INSERT INTO tests(title,unit,duration_minutes,published) VALUES($1,$2,$3,$4) RETURNING id",[title,unit,Math.max(1,+duration_minutes||60),!!published]);s.json({id:r.rows[0].id});}));
app.post("/api/tests/:id/publish",requireAuth,requireAdmin,ar(async(q,s)=>{const r=await db.query("UPDATE tests SET published=NOT published WHERE id=$1 RETURNING published",( [ +q.params.id ] ));if(!r.rowCount)return s.status(404).json({error:"Test नहीं मिला"});s.json({published:r.rows[0].published});}));
app.delete("/api/tests/:id",requireAuth,requireAdmin,ar(async(q,s)=>{await db.query("DELETE FROM tests WHERE id=$1",[+q.params.id]);s.json({ok:true});}));
app.post("/api/tests/:id/questions",requireAuth,requireAdmin,ar(async(q,s)=>{const x=q.body||{};if(!x.question_hi||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>!v)||![0,1,2,3].includes(+x.correct_index))return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर दें"});const r=await db.query("INSERT INTO questions(test_id,question_hi,question_en,options_json,correct_index,explanation) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[+q.params.id,x.question_hi,x.question_en||"",JSON.stringify(x.options),+x.correct_index,x.explanation||""]);s.json({id:r.rows[0].id});}));
app.put("/api/questions/:id",requireAuth,requireAdmin,ar(async(q,s)=>{const x=q.body||{};if(!x.question_hi||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>!v)||![0,1,2,3].includes(+x.correct_index))return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर दें"});const r=await db.query("UPDATE questions SET question_hi=$1,question_en=$2,options_json=$3,correct_index=$4,explanation=$5 WHERE id=$6 RETURNING id",[x.question_hi,x.question_en||"",JSON.stringify(x.options),+x.correct_index,x.explanation||"",+q.params.id]);if(!r.rowCount)return s.status(404).json({error:"प्रश्न नहीं मिला"});s.json({ok:true});}));
app.delete("/api/questions/:id",requireAuth,requireAdmin,ar(async(q,s)=>{const r=await db.query("DELETE FROM questions WHERE id=$1 RETURNING id",[+q.params.id]);if(!r.rowCount)return s.status(404).json({error:"प्रश्न नहीं मिला"});s.json({ok:true});}));
app.get("/api/tests/:id/questions",requireAuth,ar(async(q,s)=>{const t=(await db.query("SELECT * FROM tests WHERE id=$1",[+q.params.id])).rows[0];if(!t||(!t.published&&q.auth.role!=="admin"))return s.status(404).json({error:"Test नहीं मिला"});const rows=(await db.query("SELECT id,question_hi,question_en,options_json,correct_index,explanation FROM questions WHERE test_id=$1 ORDER BY sort_order,id",[t.id])).rows;s.json({test:{id:t.id,title:t.title,unit:t.unit,duration_minutes:t.duration_minutes},questions:rows.map(x=>({id:x.id,question_hi:x.question_hi,question_en:x.question_en,options:x.options_json,correct_index:x.correct_index,explanation:x.explanation}))});}));
app.post("/api/tests/:id/submit",requireAuth,studentOnly,ar(async(q,s)=>{const t=(await db.query("SELECT * FROM tests WHERE id=$1 AND published=TRUE",[+q.params.id])).rows[0];if(!t)return s.status(404).json({error:"Test उपलब्ध नहीं"});const qs=(await db.query("SELECT id,correct_index FROM questions WHERE test_id=$1",[t.id])).rows,ans=q.body?.answers||{},sid=+q.auth.sub;let score=0;const c=await db.pool.connect();try{await c.query("BEGIN");for(const x of qs){if(+ans[x.id]===x.correct_index){score++;await c.query("DELETE FROM wrong_questions WHERE student_id=$1 AND question_id=$2",[sid,x.id]);}else await c.query("INSERT INTO wrong_questions(student_id,test_id,question_id,last_answer) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,question_id) DO UPDATE SET last_answer=EXCLUDED.last_answer",[sid,t.id,x.id,Number.isInteger(+ans[x.id])?+ans[x.id]:null]);}await c.query("INSERT INTO attempts(student_id,test_id,score,total,answers_json) VALUES($1,$2,$3,$4,$5)",[sid,t.id,score,qs.length,JSON.stringify(ans)]);await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}s.json({score,total:qs.length,percentage:qs.length?Math.round(score/qs.length*100):0});}));
app.get("/api/wrong-questions",requireAuth,studentOnly,ar(async(q,s)=>{const r=await db.query("SELECT w.id wrong_id,q.id,q.question_hi,q.question_en,q.options_json,q.correct_index,q.explanation,t.title test_title FROM wrong_questions w JOIN questions q ON q.id=w.question_id JOIN tests t ON t.id=w.test_id WHERE w.student_id=$1 ORDER BY w.id DESC",[+q.auth.sub]);s.json(r.rows.map(x=>({...x,options:x.options_json})));}));
app.post("/api/wrong-questions/:id/resolve",requireAuth,studentOnly,ar(async(q,s)=>{const x=(await db.query("SELECT w.id,q.correct_index FROM wrong_questions w JOIN questions q ON q.id=w.question_id WHERE w.id=$1 AND w.student_id=$2",[+q.params.id,+q.auth.sub])).rows[0];if(!x)return s.status(404).json({error:"प्रश्न नहीं मिला"});if(+q.body.answer!==x.correct_index)return s.json({correct:false});await db.query("DELETE FROM wrong_questions WHERE id=$1",[x.id]);s.json({correct:true});}));
app.get("/api/attempts/mine",requireAuth,studentOnly,ar(async(q,s)=>{const r=await db.query("SELECT a.id,a.score,a.total,a.created_at,t.title,t.unit FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.student_id=$1 ORDER BY a.id DESC",[+q.auth.sub]);s.json(r.rows);}));
app.get("/api/question-bank-overrides",requireAuth,ar(async(_q,s)=>{const r=await db.query("SELECT unit,question_index,question_json FROM question_bank_edits");const edits={};for(const x of r.rows)edits[String(x.unit)+":"+String(x.question_index)]=x.question_json;s.json({edits});}));
app.put("/api/admin/question-bank/:unit/:index",requireAuth,requireAdmin,ar(async(q,s)=>{const unit=Number(q.params.unit),index=Number(q.params.index),x=q.body||{};if(!Number.isInteger(unit)||unit<1||unit>10||!Number.isInteger(index)||index<0||index>10000)return s.status(400).json({error:"यूनिट या प्रश्न क्रमांक सही नहीं है"});if(typeof x.q!=="string"||!x.q.trim()||!Array.isArray(x.options)||x.options.length!==4||x.options.some(v=>typeof v!=="string"||!v.trim())||!Number.isInteger(+x.answer)||+x.answer<0||+x.answer>3)return s.status(400).json({error:"प्रश्न, चार विकल्प और सही उत्तर आवश्यक हैं"});const value={q:x.q.trim(),en:String(x.en||""),options:x.options.map(v=>String(v).trim()),answer:+x.answer,explanation:String(x.explanation||"")};await db.query("INSERT INTO question_bank_edits(unit,question_index,question_json,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(unit,question_index) DO UPDATE SET question_json=EXCLUDED.question_json,updated_at=NOW()",[unit,index,JSON.stringify(value)]);s.json({ok:true,unit,index});}));
app.get("/api/admin/overview",requireAuth,requireAdmin,ar(async(_q,s)=>{const r=await db.query("SELECT (SELECT COUNT(*) FROM students)::int students,(SELECT COUNT(*) FROM tests)::int tests,(SELECT COUNT(*) FROM questions)::int questions,(SELECT COUNT(*) FROM attempts)::int attempts");s.json(r.rows[0]);}));
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
app.post("/api/tests/:id/import-xlsx",requireAuth,requireAdmin,upload.single("file"),ar(async(q,s)=>{if(!q.file)return s.status(400).json({error:"Excel फाइल चुनें"});const wb=XLSX.read(q.file.buffer,{type:"buffer"}),rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}),pick=(r,keys)=>{const k=Object.keys(r).find(x=>keys.includes(x.trim().toLowerCase()));return k?r[k]:"";},map={A:0,B:1,C:2,D:3,"1":0,"2":1,"3":2,"4":3};let imported=0,skipped=0;const c=await db.pool.connect();try{await c.query("BEGIN");for(let i=0;i<rows.length;i++){const r=rows[i],qh=String(pick(r,["question_hi","question","प्रश्न"])||"").trim(),opts=["a","b","c","d"].map(k=>String(pick(r,[k,"option_"+k])||"").trim()),a=map[String(pick(r,["answer","correct_answer","उत्तर"])||"").trim().toUpperCase()];if(!qh||opts.some(x=>!x)||a===undefined){skipped++;continue;}await c.query("INSERT INTO questions(test_id,question_hi,question_en,options_json,correct_index,explanation,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)",[+q.params.id,qh,String(pick(r,["question_en"])||""),JSON.stringify(opts),a,String(pick(r,["explanation","व्याख्या"])||""),i]);imported++;}await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}s.json({imported,skipped,total:rows.length});}));
app.get("/api/resources",requireAuth,ar(async(_q,s)=>{const r=await db.query("SELECT id,title,unit,file_path,created_at FROM resources ORDER BY id DESC");s.json(r.rows);}));
app.post("/api/resources",requireAuth,requireAdmin,upload.single("file"),ar(async(q,s)=>{if(!q.file)return s.status(400).json({error:"PDF/file चुनें"});const filename=Date.now()+"-"+path.basename(q.file.originalname).replace(/[^\\w.-]/g,"_"),{error}=await supabase.storage.from(bucket).upload(filename,q.file.buffer,{contentType:q.file.mimetype||"application/octet-stream",upsert:false});if(error)throw error;const r=await db.query("INSERT INTO resources(title,unit,file_path) VALUES($1,$2,$3) RETURNING id",[q.body.title||q.file.originalname,q.body.unit||"",filename]);s.json({id:r.rows[0].id});}));
app.get("/uploads/:file",ar(async(q,s)=>{const {data,error}=await supabase.storage.from(bucket).createSignedUrl(q.params.file,300);if(error)return s.status(404).json({error:"File नहीं मिली"});s.redirect(data.signedUrl);}));
// PWA app-shell headers: keep the existing quiz HTML and UI unchanged.
app.get("/",(q,s,n)=>{
  const file=path.join(__dirname,"..","public","index.html");
  require("node:fs").readFile(file,"utf8",(err,html)=>{
    if(err)return n(err);
    const head='<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0b203d"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="MPPSC IQ"><link rel="apple-touch-icon" href="/icons/mppsc-iq.svg"><meta name="mobile-web-app-capable" content="yes"><script src="https://telegram.org/js/telegram-web-app.js"></script><script>try{const w=window.Telegram&&window.Telegram.WebApp;if(w){w.ready();w.expand();try{w.setHeaderColor("#0b203d");w.setBackgroundColor("#ffffff")}catch(e){}document.documentElement.classList.add("telegram-mini-app");window.MPPSC_IQ_TELEGRAM=true;window.MPPSC_IQ_TG_USER=w.initDataUnsafe&&w.initDataUnsafe.user||null;}}catch(e){console.warn("Telegram Mini App initialization:",e)}</script>';
    const boot='<script>if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));}</script>';
    let page=html;
    if(!/rel=["']manifest["']/.test(page)) page=page.replace(/<head[^>]*>/i,m=>m+head);
    if(!page.includes('navigator.serviceWorker.register("/sw.js")')) page=page.replace(/<\/body>/i,boot+"</body>");
    const loginGate=`<style id="studentLoginGateStyle">
:root{--iq-navy:#102744;--iq-blue:#1f4e7d;--iq-gold:#e7bd62;--iq-bg:#f4f7fb;--iq-ink:#17263d;--iq-muted:#718096}
#studentLoginGate{position:fixed;inset:0;z-index:2147483000;background:var(--iq-bg);display:flex;align-items:center;justify-content:center;padding:0;font-family:system-ui,"Noto Sans Devanagari",sans-serif;color:var(--iq-ink);overflow:auto}
#studentLoginGate .gatecard{width:100%;height:100%;min-height:100%;max-width:760px;background:var(--iq-bg);padding:0 0 calc(24px + env(safe-area-inset-bottom));text-align:left;box-shadow:0 10px 45px #142b4812;overflow:auto}
#studentLoginGate .hero{background:linear-gradient(145deg,#102744,#24578a);color:#fff;padding:32px 22px 28px;border-radius:0 0 28px 28px}
#studentLoginGate .brandrow{display:flex;align-items:center;justify-content:space-between;gap:12px}
#studentLoginGate .gatebrand{font-size:27px;font-weight:950;letter-spacing:.3px;color:#fff}
#studentLoginGate .gatebrand span{color:var(--iq-gold)}
#studentLoginGate .brandtag{font-size:10px;letter-spacing:2px;color:#d8e2ef;margin-top:3px}
#studentLoginGate .hero h2{font-size:23px;line-height:1.3;color:#fff;margin:26px 0 7px}
#studentLoginGate .hero p{color:#dce7f4;margin:0;line-height:1.6;font-size:14px}
#studentLoginGate .homebody{padding:18px 16px 0}
#studentLoginGate .sectionlabel{font-size:13px;font-weight:850;color:#53647b;margin:8px 3px 12px}
#studentLoginGate .featuregrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
#studentLoginGate .feature{background:#fff;border:1px solid #e4eaf2;border-radius:17px;padding:15px;min-height:104px;box-shadow:0 3px 12px #1a34500a}
#studentLoginGate .featureicon{width:35px;height:35px;border-radius:11px;background:#eef3fa;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:10px}
#studentLoginGate .feature b{display:block;font-size:14px;color:#183452}
#studentLoginGate .feature small{display:block;font-size:11px;color:#77869a;margin-top:4px;line-height:1.4}
#studentLoginGate .progressrow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:13px}
#studentLoginGate .metric{background:#fff;border:1px solid #e4eaf2;border-radius:14px;padding:12px 9px;text-align:center}
#studentLoginGate .metric strong{display:block;font-size:21px;color:#173a60}
#studentLoginGate .metric span{font-size:10px;color:#758398}
#studentLoginGate .primaryaction{display:block;width:100%;box-sizing:border-box;background:linear-gradient(100deg,#e8c36e,#f1d895);color:#142b49;padding:16px;border:0;border-radius:14px;font-weight:900;margin-top:17px;font-size:16px;cursor:pointer;box-shadow:0 6px 16px #c49a3d30}
#studentLoginGate .home-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:17px}#studentLoginGate .home-actions .primaryaction,#studentLoginGate .home-actions .analysisaction{margin:0;min-height:54px;font-size:16px;border-radius:14px;font-weight:900;cursor:pointer}#studentLoginGate .home-actions .analysisaction{border:1px solid #c9b1e8;background:linear-gradient(135deg,#6c45a1,#43266f);color:#fff;box-shadow:0 6px 16px #54317b30}@media(max-width:420px){#studentLoginGate .home-actions{gap:8px}#studentLoginGate .home-actions .primaryaction,#studentLoginGate .home-actions .analysisaction{font-size:14px;padding:13px 6px}}\n#studentLoginGate .loginlink{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;background:var(--iq-gold);color:#102744;padding:15px;border:0;border-radius:13px;font-weight:900;margin-top:17px;font-size:15px}
#studentLoginGate button.adminEntry{display:block;width:100%;background:#fff;color:#183452;border:1px solid #dce4ef;padding:13px;border-radius:13px;font-weight:800;margin-top:10px;font-size:14px;cursor:pointer}
#studentLoginGate .footnote{display:block;text-align:center;color:#8a97a8;font-size:11px;margin:16px 0 0}
#studentHomePanel{display:none}
#studentLoginGate .studentContinue{background:#16845b;color:#fff}
#adminInsideApp{display:none;position:fixed;inset:0;z-index:2147483600;background:#fff}
#adminInsideApp iframe{width:100%;height:100%;border:0}
#adminInsideApp .closeAdmin{position:absolute;right:12px;top:10px;z-index:3;background:#e4bd55;border:0;border-radius:10px;padding:9px 14px;font-weight:900;box-shadow:0 2px 10px #0003}
@media(min-width:760px){#studentLoginGate{background:linear-gradient(135deg,#eaf0f7,#f7f9fc)}#studentLoginGate .gatecard{height:auto;min-height:0;border-radius:26px;max-height:94vh}#studentLoginGate .hero{border-radius:26px 26px 0 0;padding:34px 30px}#studentLoginGate .homebody{padding:22px 28px 26px}}
@media(max-width:380px){#studentLoginGate .hero{padding:27px 18px 23px}#studentLoginGate .homebody{padding:14px 12px 0}#studentLoginGate .feature{padding:12px;min-height:98px}}
</style>
<section id="studentLoginGate"><div class="gatecard">
<header class="hero"><div class="brandrow"><div><div class="gatebrand">MPPSC <span>IQ</span></div><div class="brandtag">GUIDING ASPIRANTS FOR EXCELLENCE</div></div><div style="font-size:11px;color:#e9d49c;border:1px solid #ffffff50;padding:7px 10px;border-radius:20px">PRELIMS</div></div>
<h2 id="gateHeading">आपकी तैयारी, अब एक बेहतर दिशा में</h2><p id="gateSubheading">MPPSC Prelims की तैयारी के लिए टेस्ट, रिवीजन और अभ्यास — एक ही प्लेटफॉर्म पर।</p></header>
<div class="homebody">
<a id="studentLoginLink" class="loginlink" href="/api/auth/telegram/start">Telegram से Student Login करें</a>
<section id="studentHomePanel">
<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><div class="sectionlabel" style="margin:0 0 4px">STUDENT DASHBOARD</div><div id="studentWelcome" style="font-size:20px;font-weight:900;color:#173452">नमस्ते, विद्यार्थी</div></div><div style="font-size:12px;color:#6d7e93;background:#fff;border:1px solid #e3eaf2;padding:8px 10px;border-radius:20px">आपका अध्ययन केंद्र</div></div>
<div class="sectionlabel" style="margin-top:21px">आपकी तैयारी के टूल</div>
<div class="featuregrid">
<div class="feature"><div class="featureicon">📚</div><b>10 विषय यूनिट</b><small>सभी यूनिट के प्रश्न एक ही स्थान पर</small></div>
<div class="feature"><div class="featureicon">🔁</div><b>रिवीजन अभ्यास</b><small>महत्वपूर्ण प्रश्नों का दोहराव</small></div>
<div class="feature"><div class="featureicon">📝</div><b>टेस्ट प्रैक्टिस</b><small>अभ्यास और अपना मूल्यांकन</small></div>
<div class="feature"><div class="featureicon">📈</div><b>प्रदर्शन ट्रैकिंग</b><small>अपने प्रयासों की प्रगति देखें</small></div>
</div>
<div class="sectionlabel" style="margin-top:20px">आपकी प्रगति</div>
<div class="progressrow"><div class="metric"><strong id="metricTests">—</strong><span>उपलब्ध टेस्ट</span></div><div class="metric"><strong id="metricAttempts">—</strong><span>आपके प्रयास</span></div><div class="metric"><strong id="metricAverage">—</strong><span>औसत स्कोर</span></div></div>
<div class="home-actions"><button type="button" class="primaryaction" onclick="document.getElementById('studentLoginGate').remove()">🔁&nbsp; रिवीजन</button><button type="button" class="analysisaction" onclick="document.getElementById('studentLoginGate').remove();showAnalysis()">📊&nbsp; एनालिसिस</button></div>
<div class="footnote">नियमित अभ्यास • सही विश्लेषण • बेहतर परिणाम</div>
</section>
<button class="adminEntry" type="button" onclick="document.getElementById('adminInsideApp').style.display='block';document.getElementById('adminInsideFrame').src='/admin.html'">Admin Login</button>
<small class="footnote" id="gateFootnote">MPPSC IQ — आपका भरोसेमंद तैयारी प्लेटफॉर्म</small>
</div></div></section>
<section id="adminInsideApp"><button class="closeAdmin" type="button" onclick="document.getElementById('adminInsideApp').style.display='none';document.getElementById('adminInsideFrame').src='about:blank'">✕ वापस ऐप पर</button><iframe id="adminInsideFrame" title="MPPSC IQ Admin"></iframe></section>
<script>(async()=>{try{const r=await fetch('/api/me',{credentials:'same-origin'});if(!r.ok)return;const u=await r.json();if(u.role!=='student')return;document.getElementById('studentLoginLink').style.display='none';document.getElementById('gateHeading').textContent='आपका स्वागत है';document.getElementById('gateSubheading').textContent='आज की तैयारी शुरू करें और अपने लक्ष्य की ओर एक कदम बढ़ाएँ।';document.getElementById('studentHomePanel').style.display='block';document.getElementById('adminInsideApp').style.display='none';document.getElementById('gateFootnote').style.display='none';const n=(u.name||'विद्यार्थी').trim();document.getElementById('studentWelcome').textContent='नमस्ते, '+n;const [tr,ar]=await Promise.all([fetch('/api/tests',{credentials:'same-origin'}),fetch('/api/attempts/mine',{credentials:'same-origin'})]);const tests=tr.ok?await tr.json():[],attempts=ar.ok?await ar.json():[];document.getElementById('metricTests').textContent=tests.length;document.getElementById('metricAttempts').textContent=attempts.length;const avg=attempts.length?Math.round(attempts.reduce((v,x)=>v+(x.total?x.score/x.total*100:0),0)/attempts.length):0;document.getElementById('metricAverage').textContent=attempts.length?avg+'%':'—';}catch(e){console.warn('Student dashboard data unavailable',e);}})();</script>`;
    if(!page.includes('id="studentLoginGate"')) page=page.replace(/<body([^>]*)>/i,'<body$1>'+loginGate);
    s.type("html").send(page);
  });
});
app.use(express.static(path.join(__dirname,"..","public")));app.get("*",(_q,s)=>s.sendFile(path.join(__dirname,"..","public","index.html")));
app.use((e,_q,s,_n)=>{console.error(e);s.status(400).json({error:e.message||"Request failed"});});
async function connectDatabase(){try{await db.init();dbReady=true;dbLastError="";console.log("Database connected and schema ready");const {error}=await supabase.storage.createBucket(bucket,{public:false,fileSizeLimit:(Number(process.env.MAX_UPLOAD_MB)||20)*1024*1024});if(error&&!String(error.message).toLowerCase().includes("already"))console.warn("Storage bucket setup:",error.message);}catch(e){dbReady=false;dbLastError=e.message||"Database connection failed";console.error("Database unavailable; web server remains online:",dbLastError);}}
app.listen(port,()=>console.log("MPPSC IQ server listening on "+port));
connectDatabase();
setInterval(()=>{if(!dbReady)connectDatabase();},30000).unref();