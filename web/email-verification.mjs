const dialog=document.getElementById('emailVerificationDialog');
const form=document.getElementById('emailVerificationForm');
const message=document.getElementById('emailVerificationMessage');
const submit=document.getElementById('emailVerificationSubmit');
const close=document.getElementById('closeVerificationDialog');
const emailFields=document.getElementById('verificationEmailFields');
const passwordFields=document.getElementById('verificationPasswordFields');
const forgot=document.getElementById('verificationForgotPassword');
let token='',busy=false,done=false;
function openVerification({email='',message:text='',verificationToken=''}={}){
  token=verificationToken;done=false;form.reset();submit.hidden=false;
  emailFields.hidden=!!token;passwordFields.hidden=!token;forgot.hidden=!token;
  emailFields.querySelector('input').disabled=!!token;
  passwordFields.querySelector('input').disabled=!token;
  document.getElementById('verificationEmail').value=email;
  document.getElementById('emailVerificationTitle').textContent=token?'Завершить регистрацию':'Подтвердите почту';
  document.getElementById('emailVerificationHint').textContent=token
    ?'Введите пароль, который вы указали при регистрации. Подтверждайте только свою регистрацию.'
    :'Откройте ссылку из письма. Если письма нет, проверьте «Спам» или запросите новое. Новое письмо можно запросить через минуту.';
  message.textContent=text;message.hidden=!text;
  submit.textContent=token?'Подтвердить почту':'Отправить письмо повторно';close.textContent='Закрыть';
  if(!dialog.open)dialog.showModal();
  document.getElementById(token?'verificationPassword':'verificationEmail').focus();
}
document.getElementById('resendVerificationBtn').addEventListener('click',()=>openVerification());
window.addEventListener('adym:email-verification-required',event=>openVerification(event.detail));
close.addEventListener('click',()=>{dialog.close();if(done)location.assign('/');});
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
dialog.addEventListener('close',()=>{form.reset();token='';});
forgot.addEventListener('click',()=>{dialog.close();document.getElementById('forgotPasswordBtn').click();});
function consumeLink(){
  const hash=new URLSearchParams(location.hash.slice(1));
  if(!hash.has('verify'))return;
  const value=hash.get('verify');
  history.replaceState(null,'',location.pathname+location.search);
  openVerification({verificationToken:value||'invalid'});
}
consumeLink();window.addEventListener('hashchange',consumeLink);
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const values=Object.fromEntries(new FormData(form));message.hidden=false;
  busy=true;submit.disabled=true;close.disabled=true;forgot.disabled=true;message.textContent='Подождите…';
  try{
    const session=await fetch('/api/session',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!session.ok)throw new Error('Не удалось проверить соединение. Повторите попытку.');
    const identity=await session.json();
    const response=await fetch(token?'/api/auth/verify-email':'/api/auth/resend-verification',{
      method:'POST',headers:{'Content-Type':'application/json','X-App-Token':identity.token},
      body:JSON.stringify(token?{token,password:values.password}:{email:values.email}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Не удалось подтвердить почту.');
    if(token){
      done=true;token='';form.reset();passwordFields.hidden=true;forgot.hidden=true;submit.hidden=true;
      message.textContent='Почта подтверждена. Теперь можно войти с логином и паролем регистрации.';
      close.textContent='Перейти ко входу';
    }else message.textContent=result.message;
  }catch(error){message.textContent=error.name==='TimeoutError'
    ?'Ответ задерживается. Попробуйте войти, если уже подтверждали почту. Иначе повторите попытку позже.'
    :error.message||'Не удалось связаться с сервером.';
  }finally{busy=false;submit.disabled=false;close.disabled=false;forgot.disabled=false;}
});
