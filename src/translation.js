// Free Hindi <-> English translation via MyMemory. No OpenAI key or paid API required.
// Anonymous free allowance: 5,000 characters/day; provider limits may change.
async function translateOneChunk(value,source,target){
 const url=new URL("https://api.mymemory.translated.net/get");
 url.searchParams.set("q",value);
 url.searchParams.set("langpair",source+"|"+target);
 const response=await fetch(url,{signal:AbortSignal.timeout(25000),headers:{"Accept":"application/json"}});
 if(!response.ok)throw new Error("Free translation provider HTTP "+response.status);
 const data=await response.json();
 const translated=data?.responseData?.translatedText;
 if(Number(data?.responseStatus)!==200||typeof translated!=="string"||!translated.trim())throw new Error(data?.responseDetails||"Free translation unavailable");
 return translated.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">");
}
async function translateSegment(text,source,target){
 const value=String(text||"").trim();
 if(!value)return "";
 // MyMemory accepts short segments; split long Hindi UTF-8 text at word boundaries.
 const words=value.split(/\s+/),chunks=[];let current="";
 for(const word of words){
  if(new TextEncoder().encode(word).length>430)throw new Error("A single word exceeds the free provider limit");
  const next=current?current+" "+word:word;
  if(current&&new TextEncoder().encode(next).length>430){chunks.push(current);current=word;}else current=next;
 }
 if(current)chunks.push(current);
 const translated=[];
 for(const chunk of chunks)translated.push(await translateOneChunk(chunk,source,target));
 return translated.join(" ");
}
async function translateQuestion(input){
 const payload={question:String(input.question||""),options:Array.isArray(input.options)?input.options.map(String):[],explanation:String(input.explanation||"")};
 const direction=input.direction==="en-hi"?["en","hi"]:["hi","en"];
 if(!payload.question||payload.options.length!==4)return null;
 try{
  // Translate each field independently to preserve option ordering and question structure.
  const question=await translateSegment(payload.question,...direction);
  const options=[];
  for(const option of payload.options)options.push(await translateSegment(option,...direction));
  const explanation=payload.explanation?await translateSegment(payload.explanation,...direction):"";
  return {question,options,explanation};
 }catch(error){console.warn("Free quiz translation unavailable:",error.message);return null;}
}
module.exports={translateQuestion};
