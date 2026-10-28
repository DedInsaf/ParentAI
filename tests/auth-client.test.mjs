import test from 'node:test';
import assert from 'node:assert/strict';
import {requestAuth} from '../web/auth-client.mjs';
const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});

test('auth obtains a fresh CSRF token on each action on a long-open page',async()=>{
  const posted=[];let generation=1;
  const fetcher=async(url,options)=>{
    if(url==='/api/session')return response(200,{token:'token-'+generation});
    posted.push(options.headers['X-App-Token']);return response(200,{ok:true});
  };
  await requestAuth('login',{password:'test'},{fetcher});generation=2;
  await requestAuth('login',{password:'test'},{fetcher});
  assert.deepEqual(posted,['token-1','token-2']);
});

test('restart between token retrieval and submission retries only a rejected CSRF request',async()=>{
  let sessions=0,posts=0,performed=0;
  const fetcher=async(url)=>{
    if(url==='/api/session'){sessions++;return response(200,{token:'token-'+sessions});}
    posts++;if(posts===1)return response(403,{error:'Invalid origin or token'});
    performed++;return response(201,{verification_required:true});
  };
  const result=await requestAuth('register',{}, {fetcher});
  assert.equal(result.verification_required,true);assert.equal(performed,1);assert.equal(sessions,2);
});

test('account denial is not retried and preserves verification details',async()=>{
  let posts=0;
  const fetcher=async(url)=>url==='/api/session'?response(200,{token:'csrf'}):
    (posts++,response(403,{error:'Подтвердите почту',verification_required:true,email:'parent@example.test'}));
  await assert.rejects(requestAuth('login',{}, {fetcher}),error=>
    error.verificationRequired===true&&error.email==='parent@example.test');
  assert.equal(posts,1);
});

test('HTML gateway errors and malformed responses have readable messages',async()=>{
  for(const invalid of [null,[],42]){
    await assert.rejects(requestAuth('login',{}, {fetcher:async()=>response(200,invalid)}),/Сервис временно недоступен/);
  }
  await assert.rejects(requestAuth('login',{}, {fetcher:async()=>({ok:false,json:async()=>{throw new SyntaxError('HTML');}})}),/Не удалось подключиться/);
  let requests=0;
  await assert.rejects(requestAuth('login',{}, {fetcher:async()=>++requests===1?response(200,{token:'csrf'}):
    {status:502,ok:false,json:async()=>{throw new SyntaxError('HTML');}}}),/Сервис временно недоступен/);
});

test('a hanging auth action times out without retrying a possible registration',async()=>{
  let posts=0;
  const fetcher=async(url,{signal})=>{
    if(url==='/api/session')return response(200,{token:'csrf'});
    posts++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  };
  await assert.rejects(requestAuth('register',{}, {fetcher,timeout:15}),/регистрация могла завершиться/);
  assert.equal(posts,1);
});
