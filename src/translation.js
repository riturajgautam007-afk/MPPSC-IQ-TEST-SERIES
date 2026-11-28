// Free server-side translation for MPPSC IQ. Public translation endpoints are rate-limited.
function decodeHtml(value){return String(value||"").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">");}
async function translateOneChunk(value,source,target){
 const url=new URL("https://translate.googleapis.com/translate_a/single");
 url.searchParams.set("client","gtx");url.searchParams.set("sl",source);url.searchParams.set("tl",target);url.searchParams.set("dt","t");url.searchParams.set("q",value);
 try{const response=await fetch(url,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(20000)});if(response.ok){const data=await response.json();const translated=Array.isArray(data?.[0])?data[0].map(x=>x?.[0]||"").join(""):"";if(translated.trim())return decodeHtml(translated);}}catch(error){console.warn("Google web translation unavailable:",error.message);}
 const fallback=new URL("https://api.mymemory.translated.net/get");fallback.searchParams.set("q",value);fallback.searchParams.set("langpair",source+"|"+target);
 const response=await fetch(fallback,{signal:AbortSignal.timeout(20000),headers:{"Accept":"application/json"}});if(!response.ok)throw new Error("Free translation provider HTTP "+response.status);
 const data=await response.json(),translated=data?.responseData?.translatedText;if(Number(data?.responseStatus)!==200||typeof translated!=="string"||!translated.trim())throw new Error(data?.responseDetails||"Free translation unavailable");return decodeHtml(translated);
}
async function translateSegment(text,source,target){
 const value=String(text||"").trim();if(!value)return "";const chunks=[];let current="";
 for(const word of value.split(/\s+/)){if(new TextEncoder().encode(word).length>430)throw new Error("A single word exceeds the translation provider limit");const next=current?current+" "+word:word;if(current&&new TextEncoder().encode(next).length>430){chunks.push(current);current=word;}else current=next;}
 if(current)chunks.push(current);const translated=[];for(const chunk of chunks)translated.push(await translateOneChunk(chunk,source,target));return translated.join(" ");
}
async function translateQuestion(input){
 const payload={question:String(input.question||""),options:Array.isArray(input.options)?input.options.map(String):[],explanation:String(input.explanation||"")};const direction=input.direction==="en-hi"?["en","hi"]:["hi","en"];if(!payload.question||payload.options.length!==4)return null;
 const marker="MPPSCQZSEP";const parts=[payload.question,...payload.options,payload.explanation];
 try{const joined=parts.join(" "+marker+" "),translated=await translateSegment(joined,...direction),split=translated.split(/\s*MPPSCQZSEP\s*/i);if(split.length>=5&&split.slice(0,5).every(x=>x.trim()))return {question:split[0].trim(),options:split.slice(1,5).map(x=>x.trim()),explanation:split.slice(5).join(" ").trim()};}catch(error){console.warn("Combined quiz translation unavailable:",error.message);}
 try{const question=await translateSegment(payload.question,...direction),options=[];for(const option of payload.options)options.push(await translateSegment(option,...direction));const explanation=payload.explanation?await translateSegment(payload.explanation,...direction):"";return {question,options,explanation};}catch(error){console.warn("Quiz translation unavailable:",error.message);return null;}
}
module.exports={translateQuestion};
