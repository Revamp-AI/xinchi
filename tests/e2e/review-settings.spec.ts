import {test,expect} from '@playwright/test';

test('settings manages subscription sign-in, model testing, activation, and disconnect',async({page})=>{
 const state:any={provider:'gateway',model:'gpt-6-astra',gatewayModel:'openai/gpt-6-astra',chatgpt:{connected:false,needsLogin:false,email:'',plan:''},test:null,login:null};
 let polling=0;
 await page.route('**/api/settings/reviews**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const body=route.request().method()==='POST'?route.request().postDataJSON():{};
  if(path.endsWith('/start'))state.login={id:'fictional-login',userCode:'ABCD-EFGH',verificationUrl:'https://auth.openai.com/codex/device',expiresAt:Date.now()+900000,interval:0.2};
  if(path.endsWith('/poll')&&++polling>=3){state.login=null;state.chatgpt={connected:true,needsLogin:false,email:'fixture@example.com',plan:'pro'};}
  if(path.endsWith('/test'))state.test={ok:true,model:body.model,at:new Date().toISOString(),message:'ChatGPT responded successfully. This model is ready for reviews.'};
  if(path.endsWith('/reviews')&&route.request().method()==='POST'){state.provider=body.provider;state.model=body.model;}
  if(path.endsWith('/disconnect')){state.chatgpt.connected=false;state.test=null;}
  await route.fulfill({json:structuredClone(state)});
 });
 await page.goto('/#settings');
 await expect(page.getByRole('heading',{level:1,name:'AI reviews'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Use ChatGPT for reviews',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Connect ChatGPT',exact:true}).click();
 await expect(page.getByText('ABCD-EFGH')).toBeVisible();
 await expect(page.getByRole('link',{name:'Open OpenAI sign-in'})).toHaveAttribute('href','https://auth.openai.com/codex/device');
 await expect(page.getByText(/Connected as fixture@example.com/)).toBeVisible();
 await page.getByRole('button',{name:'Test connection',exact:true}).click();
 await expect(page.getByText('ChatGPT responded successfully. This model is ready for reviews.')).toBeVisible();
 await page.getByLabel('Codex model').fill('different-model');
 await expect(page.getByRole('button',{name:'Use ChatGPT for reviews',exact:true})).toBeDisabled();
 await page.getByLabel('Codex model').fill('gpt-6-astra');
 await page.getByRole('button',{name:'Use ChatGPT for reviews',exact:true}).click();
 await expect(page.getByRole('button',{name:'Using ChatGPT for reviews'})).toBeDisabled();
 await page.getByRole('button',{name:'Disconnect ChatGPT',exact:true}).click();
 await expect(page.getByText('Reviews are paused until you reconnect ChatGPT.')).toBeVisible();
 await page.getByRole('button',{name:'Use AI Gateway for reviews',exact:true}).click();
 await expect(page.getByRole('button',{name:'Using AI Gateway for reviews'})).toBeDisabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('cancelled and interrupted sign-in remains recoverable',async({page})=>{
 let login:any=null;
 await page.route('**/api/settings/reviews**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/start'))login={id:'fictional-login',userCode:'ABCD-EFGH',verificationUrl:'https://auth.openai.com/codex/device',expiresAt:Date.now()+900000,interval:0.1};
  if(path.endsWith('/cancel'))login=null;
  if(path.endsWith('/poll')){await route.fulfill({status:400,json:{error:'ChatGPT is temporarily unavailable. Try again shortly.'}});return;}
  await route.fulfill({json:{provider:'gateway',model:'gpt-6-astra',gatewayModel:'openai/gpt-6-astra',chatgpt:{connected:false},login,test:null}});
 });
 await page.goto('/#settings');
 await page.getByRole('button',{name:'Connect ChatGPT',exact:true}).click();
 await expect(page.getByRole('button',{name:'Check sign-in again'})).toBeVisible();
 await page.getByRole('button',{name:'Cancel sign-in'}).click();
 await expect(page.getByText('ABCD-EFGH')).toBeHidden();
 await expect(page.getByRole('button',{name:'Connect ChatGPT',exact:true})).toBeEnabled();
});
