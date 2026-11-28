// Bidirectional server-side translation for MPPSC quiz questions.
async function translateQuestion(input){
  if(!process.env.OPENAI_API_KEY)return null;
  const payload={question:String(input.question||""),options:Array.isArray(input.options)?input.options.map(String):[],explanation:String(input.explanation||"")};
  const direction=input.direction==="en-hi"?"English to Hindi":"Hindi to English";
  if(!payload.question||payload.options.length!==4)return null;
  try{
    const response=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{"Authorization":"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},
      signal:AbortSignal.timeout(45000),
      body:JSON.stringify({
        model:process.env.OPENAI_TRANSLATION_MODEL||"gpt-4.1-mini",
        instructions:"Translate the MPPSC exam question, all four answer options, and explanation from "+direction+". Preserve every fact, number, date, name, technical term, and option order exactly. Do not answer or solve the question. Return only valid JSON: an object with string fields question and explanation and an options array of exactly four strings. Do not include markdown.",
        input:"Translate this exam content from "+direction+" and return valid JSON only. JSON input: "+JSON.stringify(payload),
        text:{format:{type:"json_object"}}
      })
    });
    if(!response.ok){const detail=(await response.text()).slice(0,1200);throw new Error("OpenAI translation HTTP "+response.status+": "+detail);}
    const data=await response.json();
    const text=(data.output||[]).flatMap(x=>x.content||[]).find(x=>x.type==="output_text")?.text;
    const result=JSON.parse(text||"{}");
    if(typeof result.question!=="string"||!result.question.trim()||!Array.isArray(result.options)||result.options.length!==4||result.options.some(x=>typeof x!=="string"||!x.trim())||typeof result.explanation!=="string")throw new Error("Invalid translation response");
    return {question:result.question,options:result.options,explanation:result.explanation};
  }catch(error){console.warn("Question translation pending:",error.message);return null;}
}
module.exports={translateQuestion};
