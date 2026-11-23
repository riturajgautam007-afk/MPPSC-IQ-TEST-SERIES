const crypto=require("node:crypto");

const BOT_USERNAME=()=>String(process.env.TELEGRAM_BOT_USERNAME||"MPPSC_IQ_Quiz_Bot").replace(/^@/,"");
function webhookSecret(){return crypto.createHmac("sha256",process.env.JWT_SECRET||"").update("mppsc-iq-telegram-webhook-v1").digest("hex");}
async function telegram(method,payload){
 const token=process.env.TELEGRAM_BOT_TOKEN;
 if(!token)throw new Error("TELEGRAM_BOT_TOKEN is not configured");
 const response=await fetch("https://api.telegram.org/bot"+token+"/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
 const data=await response.json();
 if(!response.ok||!data.ok)throw new Error(data.description||("Telegram "+method+" failed"));
 return data.result;
}
function jsonOptions(value){if(Array.isArray(value))return value;if(typeof value==="string"){try{return JSON.parse(value);}catch{return [];}}return [];}
const activeRuns=new Set();
async function sendDailyPolls(chatId,count,db){
 if(activeRuns.has(String(chatId)))return telegram("sendMessage",{chat_id:chatId,text:"इस ग्रुप में एक Revision Quiz पहले से चल रही है।"});
 activeRuns.add(String(chatId));
 try{
  const result=await db.query("SELECT q.id,q.question_hi,q.options_json,q.correct_index,q.explanation FROM questions q JOIN tests t ON t.id=q.test_id WHERE t.published=TRUE ORDER BY random() LIMIT $1",[count]);
  const rows=result.rows||[];
  if(!rows.length)return telegram("sendMessage",{chat_id:chatId,text:"अभी प्रकाशित Question Bank में प्रश्न उपलब्ध नहीं हैं। Admin से टेस्ट Publish करवाएँ।"});
  const eligible=rows.filter(q=>{const opts=jsonOptions(q.options_json);return String(q.question_hi||"").trim().length>0&&String(q.question_hi).length<=300&&opts.length===4&&opts.every(x=>String(x||"").trim().length>0&&String(x).length<=100)&&Number.isInteger(Number(q.correct_index))&&Number(q.correct_index)>=0&&Number(q.correct_index)<=3;});
  await telegram("sendMessage",{chat_id:chatId,text:"📚 MPPSC IQ | DAILY REVISION QUIZ\nआज के "+count+" प्रश्नों का अभ्यास शुरू।\nकुल उपलब्ध: "+rows.length+" | Telegram सीमा के कारण योग्य: "+eligible.length+"\n\nहर प्रश्न का सही उत्तर Poll में चुनें।"});
  let sent=0,failed=0;
  for(const q of eligible){
   try{
    const options=jsonOptions(q.options_json).map(x=>({text:String(x)}));
    const payload={chat_id:chatId,question:String(q.question_hi),options,type:"quiz",correct_option_id:Number(q.correct_index),is_anonymous:false};
    const explanation=String(q.explanation||"").trim();
    if(explanation)payload.explanation=explanation.slice(0,200);
    await telegram("sendPoll",payload);sent++;
   }catch(e){failed++;console.error("Revision poll send failed for question",q.id,e.message);}
   await new Promise(resolve=>setTimeout(resolve,1100));
  }
  const skipped=rows.length-eligible.length;
  await telegram("sendMessage",{chat_id:chatId,text:"✅ आज की Revision Quiz पूरी हुई।\nभेजे गए Poll: "+sent+"\nसीमा/डेटा के कारण छोड़े गए: "+skipped+"\nभेजने में त्रुटि: "+failed+"\n\nअगली प्रैक्टिस के लिए /revision 50 या /revision 100 लिखें।"});
 }finally{activeRuns.delete(String(chatId));}
}
async function handleUpdate(update,db){
 const message=update&&update.message;
 if(!message||!message.text)return;
 const text=String(message.text).trim();
 const match=text.match(/^\/(start|revision|help)(?:@([A-Za-z0-9_]+))?(?:\s+(\d+))?$/i);
 if(!match)return;
 if(match[2]&&match[2].toLowerCase()!==BOT_USERNAME().toLowerCase())return;
 const command=match[1].toLowerCase(),chat=message.chat||{},chatId=chat.id;
 if(!chatId)return;
 if(chat.type==="private"){
  if(command==="help")return telegram("sendMessage",{chat_id:chatId,text:"MPPSC IQ सहायता\n/start — MPPSC IQ App खोलें"});
  const url=String(process.env.APP_BASE_URL||process.env.RENDER_EXTERNAL_URL||"https://mppsc-iq-telegram-platform-mdri.onrender.com").replace(/\/$/,"")+"/app";
  return telegram("sendMessage",{chat_id:chatId,text:"MPPSC IQ खोलने के लिए नीचे बटन दबाएँ।",reply_markup:{inline_keyboard:[[{text:"📚 MPPSC IQ खोलें",web_app:{url}}]]}});
 }
 if(chat.type!=="group"&&chat.type!=="supergroup")return;
 if(command==="help"||command==="start"){
  const sent=await telegram("sendMessage",{chat_id:chatId,text:"📚 MPPSC IQ | DAILY REVISION QUIZ\n\nग्रुप में ही Telegram Quiz Polls के माध्यम से अभ्यास करें।\n\n50 प्रश्न: /revision 50\n100 प्रश्न: /revision 100\n\nहर प्रश्न में चार विकल्प और सही उत्तर रहेगा।"});
  if(command==="start"){try{await telegram("pinChatMessage",{chat_id:chatId,message_id:sent.message_id,disable_notification:true});}catch(e){console.warn("Could not pin revision instructions:",e.message);}}
  return;
 }
 const requested=Number(match[3]||50);
 if(![50,100].includes(requested))return telegram("sendMessage",{chat_id:chatId,text:"कृपया /revision 50 या /revision 100 चुनें।"});
 await sendDailyPolls(chatId,requested,db);
}
function registerTelegramBot(app,db){
 app.post("/telegram/webhook",async(req,res)=>{
  const expected=webhookSecret(),received=String(req.get("x-telegram-bot-api-secret-token")||"");
  if(received.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected)))return res.sendStatus(401);
  res.sendStatus(200);
  try{await handleUpdate(req.body,db);}catch(e){console.error("Telegram update failed:",e.message);}
 });
 async function configure(){
  if(!process.env.TELEGRAM_BOT_TOKEN)return;
  try{
   const result=await telegram("setWebhook",{url:(String(process.env.APP_BASE_URL||process.env.RENDER_EXTERNAL_URL||"https://mppsc-iq-telegram-platform-mdri.onrender.com").replace(/\/$/,""))+"/telegram/webhook",secret_token:webhookSecret(),allowed_updates:["message"],drop_pending_updates:false});
   await telegram("setMyCommands",{commands:[{command:"start",description:"ग्रुप में Revision निर्देश पिन करें"},{command:"revision",description:"50 या 100 Telegram Quiz Polls शुरू करें"},{command:"help",description:"Revision Quiz सहायता"}]});
   console.log("Telegram webhook configured:",result);
  }catch(e){console.error("Telegram webhook setup failed:",e.message);}
 }
 return {configure};
}
module.exports={registerTelegramBot};
