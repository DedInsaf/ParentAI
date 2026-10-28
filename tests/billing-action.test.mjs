import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const action=script.slice(script.indexOf('async function buyPlan('),script.indexOf("$('buyPaidBtn').addEventListener"));
function fixture(enabled){
  const elements=new Map();let calls=0;
  const context=vm.createContext({currentUser:{email:'parent@example.test',telegram_username:'@parent'},
    status:{billing:{provider:{enabled}}},billingNotice:'',pendingActions:new Set(),clearError(){},controls(){},
    $(id){if(!elements.has(id))elements.set(id,{textContent:'',focus(){}});return elements.get(id);},
    async api(){calls++;throw new Error('Платёжный сервис временно недоступен');},
    fail(){throw new Error('Payment error must be visible inside its dialog');},URL,location:{assign(){throw new Error('Unexpected payment navigation');}}});
  vm.runInContext(action,context);
  return {context,elements,calls:()=>calls};
}
test('a disconnected payment provider shows a clickable placeholder without creating a payment',async()=>{
  const f=fixture(false);await f.context.buyPlan('ultra','buyUltraBtn');
  assert.match(f.elements.get('billingMessage').textContent,/временно недоступна/);
  assert.match(f.elements.get('billingMessage').textContent,/Списаний не будет/);
  assert.equal(f.calls(),0);
});
test('a checkout failure remains visible inside the tariff dialog',async()=>{
  const f=fixture(true);await f.context.buyPlan('paid','buyPaidBtn');
  assert.match(f.elements.get('billingMessage').textContent,/Платёжный сервис временно недоступен/);
  assert.equal(f.context.billingNotice,f.elements.get('billingMessage').textContent);
  assert.equal(f.context.pendingActions.size,0);
});
