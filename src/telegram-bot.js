const crypto=require("node:crypto");

const BASE_URL=()=>String(process.env.APP_BASE_URL||process.env.RENDER_EXTERNAL_URL||"https://mppsc-iq-telegram-platform-mdri.onrender.com").replace(/\/$/,"");
const BOT_USERNAME=()=>String(process.env.TELEGRAM_BOT_USERNAME||"MPPSC_IQ_Quiz_Bot").replace(/^@/,"");
function webhookSecret(){return crypto.createHmac("sha256",process.env.JWT_SECRET||"").update("mppsc-iq-telegram-webhook-v1").digest("hex");}
async function telegram(method,payload){
 const token=process.env.TELEGRAM_BOT_TOKEN;
 if(!token)throw new Error("TELEGRAM_BOT_TOKEN is not configured");
 const response=await fetch("https://api.telegram.org/bot"+token+"/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
 const data=await response.json();
 if(!response.ok||!data.ok)throw new Error(data.description||("Telegram "+method+" failed"));
 return data.result;
}
async function sendPrivateLaunch(chatId){
 const url=BASE_URL()+"/app";
 return telegram("sendMessage",{chat_id:chatId,text:"MPPSC IQ Revision खोलने के लिए नीचे बटन दबाएँ।\n\nयदि पहली बार उपयोग कर रहे हैं, तो Telegram Login पूरा करें।",reply_markup:{inline_keyboard:[[{text:"📚 MPPSC IQ खोलें",web_app:{url}}]]}});
}
async function handleUpdate(update){
 const message=update&&update.message;
 if(!message||!message.text)return;
 const text=String(message.text).trim();
 const match=text.match(/^\/(start|revision|help)(?:@([A-Za-z0-9_]+))?(?:\s+(.+))?$/i);
 if(!match)return;
 if(match[2]&&match[2].toLowerCase()!==BOT_USERNAME().toLowerCase())return;
 const command=match[1].toLowerCase(),chat=message.chat||{},chatId=chat.id;
 if(!chatId)return;
 if(chat.type==="private"){
  if(command==="help")return telegram("sendMessage",{chat_id:chatId,text:"MPPSC IQ सहायता\n/start — Revision App खोलें\n/revision — Revision App खोलें"});
  return sendPrivateLaunch(chatId);
 }
 if(command==="help")return telegram("sendMessage",{chat_id:chatId,text:"Daily Revision Quiz शुरू करने के लिए /revision लिखें।"});
 if(command==="start"||command==="revision"){
  const link="https://t.me/"+BOT_USERNAME()+"?start=revision";
  const sent=await telegram("sendMessage",{chat_id:chatId,text:"📚 MPPSC IQ — DAILY REVISION\n\nअपनी व्यक्तिगत Revision Quiz खोलने के लिए नीचे बटन दबाएँ। पहली बार उपयोग करने वाले विद्यार्थी निजी बॉट चैट में Start दबाएँ।",reply_markup:{inline_keyboard:[[{text:"🚀 Revision Quiz खोलें",url:link}]]}});
  if(chat.type==="group"||chat.type==="supergroup"){
   try{await telegram("pinChatMessage",{chat_id:chatId,message_id:sent.message_id,disable_notification:true});}catch(e){console.warn("Could not pin revision post:",e.message);}
  }
 }
}
function registerTelegramBot(app){
 app.post("/telegram/webhook",async(req,res)=>{
  const expected=webhookSecret(),received=String(req.get("x-telegram-bot-api-secret-token")||"");
  if(!received||!crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected)))return res.sendStatus(401);
  res.sendStatus(200);
  try{await handleUpdate(req.body);}catch(e){console.error("Telegram update failed:",e.message);}
 });
 async function configure(){
  if(!process.env.TELEGRAM_BOT_TOKEN)return;
  try{
   const result=await telegram("setWebhook",{url:BASE_URL()+"/telegram/webhook",secret_token:webhookSecret(),allowed_updates:["message"],drop_pending_updates:false});
   await telegram("setMyCommands",{commands:[{command:"start",description:"MPPSC IQ Revision खोलें"},{command:"revision",description:"ग्रुप में Daily Revision पोस्ट करें"},{command:"help",description:"सहायता"}]});
   console.log("Telegram webhook configured:",result);
  }catch(e){console.error("Telegram webhook setup failed:",e.message);}
 }
 return {configure};
}
module.exports={registerTelegramBot};
