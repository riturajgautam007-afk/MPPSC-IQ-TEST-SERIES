const crypto=require("node:crypto");
const jwt=require("jsonwebtoken");
function verifyTelegramInitData(initData,token){
 if(!initData||!token)throw Error("Telegram login is not configured");
 const p=new URLSearchParams(initData),hash=p.get("hash");if(!hash)throw Error("Missing Telegram signature");p.delete("hash");
 const authDate=Number(p.get("auth_date")||0),now=Math.floor(Date.now()/1000);
 if(!authDate||authDate>now+60||now-authDate>86400)throw Error("Login expired");
 const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
 const secret=crypto.createHmac("sha256","WebAppData").update(token).digest();
 const actual=crypto.createHmac("sha256",secret).update(check).digest("hex");
 const a=Buffer.from(actual,"hex"),b=Buffer.from(hash,"hex");
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Error("Invalid Telegram signature");
 const user=JSON.parse(p.get("user")||"{}");if(!user.id)throw Error("Telegram user missing");return user;
}
function issueToken(payload,secret){return jwt.sign(payload,secret,{expiresIn:"7d",issuer:"mppsc-iq"});}
function requireAuth(req,res,next){try{const h=req.headers.authorization||"",cookies=Object.fromEntries((req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));const bearer=h.startsWith("Bearer ")?h.slice(7):"";req.auth=jwt.verify(bearer||cookies.mppsc_iq_token||"",process.env.JWT_SECRET,{issuer:"mppsc-iq"});next();}catch{res.status(401).json({error:"Login required"});}}
function requireAdmin(req,res,next){if(req.auth?.role!=="admin")return res.status(403).json({error:"Admin only"});next();}
module.exports={verifyTelegramInitData,issueToken,requireAuth,requireAdmin};
