import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudReviewFailure} from '../lib/cloud-errors.mjs';

test('recognizes a restricted model in the Gateway HTTP error even when the SDK calls it internal',()=>{
 const error={name:'GatewayInternalServerError',statusCode:403,cause:{responseBody:JSON.stringify({error:{type:'no_providers_available',param:{name:'RestrictedModelsError'}},providerMetadata:{gateway:{generationId:'gen_fixture123'}}})}};
 const result=cloudReviewFailure(error);
 assert.equal(result.diagnostic.reason,'model_requires_paid_credits');
 assert.equal(result.diagnostic.generationId,'gen_fixture123');
 assert.match(result.message,/requires paid AI Gateway credits/);
 assert.match(result.message,/Vercel Pro hosting/);
});
test('recognizes the free-tier rejection text without requiring SDK-specific classes',()=>{
 assert.equal(cloudReviewFailure({statusCode:403,message:'Free tier users do not have access to this model.'}).diagnostic.reason,'model_requires_paid_credits');
});
test('distinguishes credentials, billing, permissions, rate limits, and service failures',()=>{
 for(const [statusCode,reason] of [[401,'authentication'],[402,'billing'],[403,'access_denied'],[429,'rate_limited'],[503,'gateway_unavailable']]){
  const result=cloudReviewFailure({lastError:{statusCode}});
  assert.equal(result.diagnostic.reason,reason);
  assert.equal(result.diagnostic.statusCode,statusCode);
 }
});
test('never serializes raw provider payloads, prompts, credentials, or arbitrary error messages',()=>{
 const privateText='private-fixture-token-and-message';
 const result=cloudReviewFailure({statusCode:403,name:privateText,message:privateText,requestBodyValues:{prompt:privateText},responseBody:JSON.stringify({error:{message:privateText},providerMetadata:{gateway:{generationId:privateText}}})});
 assert.equal(JSON.stringify(result).includes(privateText),false);
 assert.deepEqual(result.diagnostic,{reason:'access_denied',statusCode:403});
});
test('handles malformed responses, cyclic causes, and null errors',()=>{
 const error={responseBody:'not json'};error.cause=error;
 for(const value of [error,null,'unexpected'])assert.equal(cloudReviewFailure(value).diagnostic.reason,'unverified_result');
});
test('interruption takes precedence over a coincident gateway error',()=>{
 assert.equal(cloudReviewFailure({statusCode:403,message:'Free tier users do not have access to this model.'},{aborted:true}).diagnostic.reason,'interrupted');
});
