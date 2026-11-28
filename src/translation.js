// Google Cloud Translation Basic (v2) with a free MyMemory fallback.
// Set GOOGLE_TRANSLATE_API_KEY on Render to enable Google translation server-side.
async function translateOneChunk(value,source,target){
 const googleKey=String(process.env.GOOGLE_TRANSLATE_API_KEY||"").trim();
 if(googleKey){
  const response=await fetch("https://translation.googleapis.com/language/translate/v2?key="+encodeURIComponent(googleKey),{
   method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},
   body:JSON.stringify({q:value,source,target,format:"text"}),signal:AbortSignal.timeout(25000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.error?.message||("Google Translation HTTP "+response.status));
  const translated=data?.data?.translations?.[0]?.translatedText;
  if(typeof translated!=="string"||!translated.trim())throw new Error("Google Translation returned an empty result");
  return translated.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">");
 }
 // Temporary free fallback until the Google API key is configured in Render.
 const url=new URL("https://api.mymemory.translated.net/get");
 url.searchParams.set("q",value);url.searchParams.set("langpair",source+"|"+target);
 const response=await fetch(url,{signal:AbortSignal.timeout(25000),headers:{"Accept":"application/json"}});
 if(!response.ok)throw new Error("Free translation provider HTTP "+response.status);
 const data=await response.json(),translated=data?.responseData?.translatedText;
 if(Number(data?.responseStatus)!==200||typeof translated!=="string"||!translated.trim())throw new Error(data?.responseDetails||"Free translation unavailable");
 return translated.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">");
}
async function translateSegment(text,source,target){
 const value=String(text||"").trim();if(!value)return "";
 const words=value.split(/\\s+/),chunks=[];let current="";
 for(const word of words){
  if(new TextEncoder().encode(word).length>430)throw new Error("A single word exceeds the translation provider limit");
  const next=current?current+" "+word:word;
  if(current&&new TextEncoder().encode(next).length>430){chunks.push(current);current=word;}else current=next;
 }
 if(current)chunks.push(current);
 const translated=[];for(const chunk of chunks)translated.push(await translateOneChunk(chunk,source,target));
 return translated.join(" ");
}
async function translateQuestion(input){
 const payload={question:String(input.question||""),options:Array.isArray(input.options)?input.options.map(String):[],explanation:String(input.explanation||"")};
 const direction=input.direction==="en-hi"?["en","hi"]:["hi","en"];
 if(!payload.question||payload.options.length!==4)return null;
 try{
  const question=await translateSegment(payload.question,...direction),options=[];
  for(const option of payload.options)options.push(await translateSegment(option,...direction));
  const explanation=payload.explanation?await translateSegment(payload.explanation,...direction):"";
  return {question,options,explanation};
 }catch(error){console.warn("Quiz translation unavailable:",error.message);return null;}
}
module.exports={translateQuestion};
