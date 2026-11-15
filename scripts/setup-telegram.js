require("dotenv").config();
const token=process.env.TELEGRAM_BOT_TOKEN,url=(process.env.APP_BASE_URL||"").replace(/\/$/,""),wanted=(process.env.TELEGRAM_BOT_USERNAME||"MPPSC_IQ_Quiz_Bot").replace(/^@/,"");
if(!token||!/^https:\/\//.test(url)){console.error("Set TELEGRAM_BOT_TOKEN and deployed HTTPS APP_BASE_URL privately.");process.exit(1);}
(async()=>{const call=async(method,body)=>{const r=await fetch("https://api.telegram.org/bot"+token+"/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw Error(j.description);return j.result;};
const bot=await call("getMe",{});if(bot.username.toLowerCase()!==wanted.toLowerCase())throw Error("Token does not match @"+wanted);
await call("setChatMenuButton",{menu_button:{type:"web_app",text:"MPPSC IQ खोलें",web_app:{url}}});
await call("setMyCommands",{commands:[{command:"start",description:"MPPSC IQ खोलें"},{command:"help",description:"सहायता"}]});
console.log("Configured @"+bot.username+" -> "+url);})().catch(e=>{console.error(e.message);process.exit(1)});
