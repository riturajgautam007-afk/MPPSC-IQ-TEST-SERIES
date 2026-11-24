// Server-side Hindi to English translation. The API key is read only from Render Environment.
async function translateQuestion(input){
  if(!process.env.OPENAI_API_KEY)return null;
  const payload={question:String(input.question||""),options:Array.isArray(input.options)?input.options.map(String):[],explanation:String(input.explanation||"")};
  if(!payload.question||payload.options.length!==4)return null;
  try{
    const response=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{"Authorization":"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},
      signal:AbortSignal.timeout(45000),
      body:JSON.stringify({
        model:process.env.OPENAI_TRANSLATION_MODEL||"gpt-4.1-mini",
        instructions:"Translate the Hindi exam question, all four answer options, and explanation into accurate, natural English. Preserve every fact, number, date, name, technical term, punctuation meaning, and option order. Do not answer or solve the question. Return only valid JSON (JavaScript Object Notation): a JSON object with string fields question, explanation and an options array of exactly four strings. Do not include markdown or text outside the JSON object.",
        input:"Translate the following Hindi exam content and return the result as valid JSON only, with keys question, options, explanation. JSON input: "+JSON.stringify(payload),
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
