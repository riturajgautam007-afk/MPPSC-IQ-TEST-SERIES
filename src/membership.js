const PRICE=()=>Math.max(1,Number(process.env.MEMBERSHIP_PRICE_INR)||300);
const BATCH=()=>process.env.MEMBERSHIP_BATCH_NAME||"MPPSC PRE 2027";
async function ensureSchema(db){
 await db.query(`CREATE TABLE IF NOT EXISTS student_memberships(
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('inactive','active','expired','revoked')),
  batch TEXT NOT NULL DEFAULT 'MPPSC PRE 2027',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  amount_inr INTEGER NOT NULL DEFAULT 300,
  activated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS membership_payment_requests(
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount_inr INTEGER NOT NULL,
  utr TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_membership_requests_status ON membership_payment_requests(status,created_at DESC);
 CREATE INDEX IF NOT EXISTS idx_memberships_status ON student_memberships(status,ends_at);`);
}
function requirePaid(db){
 return async(q,s,n)=>{
  if(q.auth?.role==="admin")return n();
  try{
   const r=await db.query("SELECT status,ends_at FROM student_memberships WHERE student_id=$1",[Number(q.auth.sub)]);
   const m=r.rows[0],active=!!m&&m.status==="active"&&(!m.ends_at||new Date(m.ends_at).getTime()>Date.now());
   if(active)return n();
   return s.status(402).json({code:"MEMBERSHIP_REQUIRED",error:"इस सुविधा के लिए सक्रिय Paid Membership आवश्यक है।",membership:m||{status:"inactive"}});
  }catch(e){return n(e);}
 };
}
function register(app,{db,requireAuth,requireAdmin,ar}){
 app.get("/api/membership/me",requireAuth,ar(async(q,s)=>{
  if(q.auth.role==="admin")return s.json({role:"admin",membership:{status:"active",batch:"Admin"},payment:{amount:PRICE(),upiId:process.env.MEMBERSHIP_UPI_ID||""}});
  const [m,p]=await Promise.all([
   db.query("SELECT status,batch,starts_at,ends_at,amount_inr,updated_at FROM student_memberships WHERE student_id=$1",[Number(q.auth.sub)]),
   db.query("SELECT id,status,amount_inr,utr,created_at FROM membership_payment_requests WHERE student_id=$1 ORDER BY id DESC LIMIT 1",[Number(q.auth.sub)])
  ]);
  let membership=m.rows[0]||{status:"inactive",batch:BATCH()};
  if(membership.status==="active"&&membership.ends_at&&new Date(membership.ends_at).getTime()<=Date.now())membership={...membership,status:"expired"};
  s.json({role:"student",membership,payment:{amount:PRICE(),upiId:process.env.MEMBERSHIP_UPI_ID||""},latestRequest:p.rows[0]||null});
 }));
 app.post("/api/membership/payment-request",requireAuth,ar(async(q,s)=>{
  if(q.auth.role!=="student")return s.status(400).json({error:"यह सुविधा केवल विद्यार्थियों के लिए है"});
  const utr=String(q.body?.utr||"").trim(),note=String(q.body?.note||"").trim().slice(0,500);
  if(!/^[A-Za-z0-9-]{6,80}$/.test(utr))return s.status(400).json({error:"कृपया सही UTR / Transaction ID दर्ज करें (कम से कम 6 अक्षर)।"});
  const pending=await db.query("SELECT id FROM membership_payment_requests WHERE student_id=$1 AND status='pending'",[Number(q.auth.sub)]);
  if(pending.rowCount)return s.status(409).json({error:"आपका एक भुगतान अनुरोध पहले से समीक्षा में है।"});
  const r=await db.query("INSERT INTO membership_payment_requests(student_id,amount_inr,utr,note) VALUES($1,$2,$3,$4) RETURNING id,status,created_at",[Number(q.auth.sub),PRICE(),utr,note]);
  s.status(201).json({ok:true,request:r.rows[0]});
 }));
 app.get("/api/admin/membership/overview",requireAuth,requireAdmin,ar(async(_q,s)=>{
  const r=await db.query("SELECT (SELECT COUNT(*)::int FROM students) students,(SELECT COUNT(*)::int FROM student_memberships WHERE status='active' AND (ends_at IS NULL OR ends_at>NOW())) active,(SELECT COUNT(*)::int FROM membership_payment_requests WHERE status='pending') pending");
  s.json(r.rows[0]);
 }));
 app.get("/api/admin/membership/requests",requireAuth,requireAdmin,ar(async(_q,s)=>{
  const r=await db.query("SELECT p.id,p.student_id,p.amount_inr,p.utr,p.note,p.status,p.created_at,st.name,st.username,st.telegram_id FROM membership_payment_requests p JOIN students st ON st.id=p.student_id WHERE p.status='pending' ORDER BY p.created_at ASC");
  s.json(r.rows);
 }));
 app.get("/api/admin/membership/students",requireAuth,requireAdmin,ar(async(_q,s)=>{
  const r=await db.query("SELECT st.id,st.name,st.username,st.telegram_id,st.created_at,m.status,m.batch,m.starts_at,m.ends_at,m.amount_inr FROM students st LEFT JOIN student_memberships m ON m.student_id=st.id ORDER BY st.id DESC");
  s.json(r.rows);
 }));
 app.post("/api/admin/membership/requests/:id/approve",requireAuth,requireAdmin,ar(async(q,s)=>{
  const days=Math.min(730,Math.max(1,Number(q.body?.days)||365)),batch=String(q.body?.batch||BATCH()).trim().slice(0,100),admin=String(q.auth.sub||"admin");
  const c=await db.pool.connect();
  try{
   await c.query("BEGIN");
   const pr=await c.query("SELECT * FROM membership_payment_requests WHERE id=$1 AND status='pending' FOR UPDATE",[Number(q.params.id)]);
   if(!pr.rowCount){await c.query("ROLLBACK");return s.status(404).json({error:"Pending payment request नहीं मिला"});}
   const x=pr.rows[0];
   await c.query("INSERT INTO student_memberships(student_id,status,batch,starts_at,ends_at,amount_inr,activated_by,updated_at) VALUES($1,'active',$2,NOW(),NOW()+($3::text||' days')::interval,$4,$5,NOW()) ON CONFLICT(student_id) DO UPDATE SET status='active',batch=EXCLUDED.batch,starts_at=NOW(),ends_at=NOW()+($3::text||' days')::interval,amount_inr=EXCLUDED.amount_inr,activated_by=EXCLUDED.activated_by,updated_at=NOW()",[x.student_id,batch,days,x.amount_inr,admin]);
   await c.query("UPDATE membership_payment_requests SET status='approved',reviewed_at=NOW(),reviewed_by=$2 WHERE id=$1",[x.id,admin]);
   await c.query("COMMIT");s.json({ok:true,student_id:x.student_id,days,batch});
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
 }));
 app.post("/api/admin/membership/students/:id/activate",requireAuth,requireAdmin,ar(async(q,s)=>{
  const days=Math.min(730,Math.max(1,Number(q.body?.days)||365)),batch=String(q.body?.batch||BATCH()).trim().slice(0,100),amount=Math.max(0,Number(q.body?.amount_inr)||PRICE());
  const r=await db.query("INSERT INTO student_memberships(student_id,status,batch,starts_at,ends_at,amount_inr,activated_by,updated_at) SELECT id,'active',$2,NOW(),NOW()+($3::text||' days')::interval,$4,$5,NOW() FROM students WHERE id=$1 ON CONFLICT(student_id) DO UPDATE SET status='active',batch=EXCLUDED.batch,starts_at=NOW(),ends_at=NOW()+($3::text||' days')::interval,amount_inr=EXCLUDED.amount_inr,activated_by=EXCLUDED.activated_by,updated_at=NOW() RETURNING student_id",[Number(q.params.id),batch,days,amount,String(q.auth.sub||"admin")]);
  if(!r.rowCount)return s.status(404).json({error:"विद्यार्थी नहीं मिला"});
  s.json({ok:true,student_id:r.rows[0].student_id,days,batch});
 }));
 app.post("/api/admin/membership/students/:id/revoke",requireAuth,requireAdmin,ar(async(q,s)=>{
  const r=await db.query("UPDATE student_memberships SET status='revoked',updated_at=NOW(),activated_by=$2 WHERE student_id=$1 RETURNING student_id",[Number(q.params.id),String(q.auth.sub||"admin")]);
  if(!r.rowCount)return s.status(404).json({error:"Membership रिकॉर्ड नहीं मिला"});
  s.json({ok:true,student_id:r.rows[0].student_id});
 }));
 app.post("/api/admin/membership/requests/:id/reject",requireAuth,requireAdmin,ar(async(q,s)=>{
  const r=await db.query("UPDATE membership_payment_requests SET status='rejected',reviewed_at=NOW(),reviewed_by=$2 WHERE id=$1 AND status='pending' RETURNING id",[Number(q.params.id),String(q.auth.sub||"admin")]);
  if(!r.rowCount)return s.status(404).json({error:"Pending request नहीं मिला"});
  s.json({ok:true});
 }));
}
module.exports={ensureSchema,requirePaid,register};
