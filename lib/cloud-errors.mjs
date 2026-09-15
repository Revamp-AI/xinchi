// Gateway errors can wrap the HTTP response (and SDK retry errors can wrap those).
// Inspect the error locally, but only return fixed messages and safe diagnostic fields.
function details(error){
 const nodes=[],seen=new Set();
 for(let node=error;node&&typeof node==='object'&&!seen.has(node)&&nodes.length<8;node=node.cause||node.lastError){seen.add(node);nodes.push(node);}
 return nodes.flatMap(node=>{
  let response=node.data||node.response;
  if(!response&&typeof node.responseBody==='string'&&node.responseBody.length<=65536){try{response=JSON.parse(node.responseBody);}catch{}}
  return[node,response?.error,response?.error?.param,{generationId:response?.providerMetadata?.gateway?.generationId}].filter(value=>value&&typeof value==='object');
 });
}
export function cloudReviewFailure(error,{aborted=false}={}){
 const nodes=details(error);
 const statusCode=nodes.find(node=>Number.isInteger(node.statusCode)&&node.statusCode>=400&&node.statusCode<=599)?.statusCode;
 const restricted=statusCode===403&&nodes.some(node=>node.name==='RestrictedModelsError'||(typeof node.message==='string'&&/free tier users do not have access to this model/i.test(node.message)));
 let reason='unverified_result',message='The cloud review could not produce verified results. Retry or narrow the question.';
 if(aborted){reason='interrupted';message='The cloud review was interrupted or timed out. Retry with a narrower question.';}
 else if(restricted){reason='model_requires_paid_credits';message='The selected review model requires paid AI Gateway credits. Add credits in Vercel, or configure a model available on the free tier. Vercel Pro hosting does not include this model access.';}
 else if(statusCode===401){reason='authentication';message='AI Gateway could not authenticate this workspace. Check the deployment’s Gateway credentials.';}
 else if(statusCode===402){reason='billing';message='AI Gateway rejected the review for billing or credit limits. Check the Gateway balance and spending limits in Vercel.';}
 else if(statusCode===403){reason='access_denied';message='AI Gateway denied access to the selected review model. Check the team’s model permissions and routing rules in Vercel.';}
 else if(statusCode===429){reason='rate_limited';message='AI Gateway is rate limiting reviews. Wait briefly, then try again.';}
 else if(statusCode>=500){reason='gateway_unavailable';message='The cloud model service is temporarily unavailable. Try the review again later.';}
 const generationId=nodes.map(node=>node.generationId).find(value=>typeof value==='string'&&/^gen_[A-Za-z0-9_-]{1,120}$/.test(value));
 return{message,diagnostic:{reason,...(statusCode?{statusCode}:{}),...(generationId?{generationId}:{})}};
}
