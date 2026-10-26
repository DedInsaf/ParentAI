const dialog=document.getElementById('passwordRecoveryDialog');
const form=document.getElementById('passwordRecoveryForm');
const message=document.getElementById('passwordRecoveryMessage');
const submit=document.getElementById('passwordRecoverySubmit');
const close=document.getElementById('closeRecoveryDialog');
const emailFields=document.getElementById('recoveryEmailFields');
const passwordFields=document.getElementById('recoveryPasswordFields');
let token='',busy=false;
function openRecovery(resetToken=''){
  close.textContent='Закрыть';close.onclick=null;
  token=resetToken;form.reset();message.hidden=true;submit.hidden=false;
  emailFields.hidden=!!token;passwordFields.hidden=!token;
  emailFields.querySelector('input').disabled=!!token;
  passwordFields.querySelectorAll('input').forEach(input=>{input.disabled=!token;});
  document.getElementById('passwordRecoveryTitle').textContent=token?'Новый пароль':'Восстановить пароль';
  document.getElementById('passwordRecoveryHint').textContent=token
    ?'Придумайте пароль от 8 символов. После сохранения войдите с новым паролем.'
    :'Укажите почту, с которой вы зарегистрировались. Мы отправим ссылку для смены пароля.';
  submit.textContent=token?'Сохранить пароль':'Отправить ссылку';
  if(!dialog.open)dialog.showModal();
  document.getElementById(token?'recoveryPassword':'recoveryEmail').focus();
}
document.getElementById('forgotPasswordBtn').addEventListener('click',()=>openRecovery());
close.addEventListener('click',()=>dialog.close());
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
dialog.addEventListener('close',()=>{form.reset();token='';});
function consumeLink(){
  const hash=new URLSearchParams(location.hash.slice(1));
  if(!hash.has('reset'))return;
  const value=hash.get('reset');
  history.replaceState(null,'',location.pathname+location.search);
  openRecovery(value||'invalid');
}
consumeLink();window.addEventListener('hashchange',consumeLink);
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const values=Object.fromEntries(new FormData(form));message.hidden=false;
  if(token&&values.new_password!==values.confirmation){message.textContent='Пароли не совпадают.';return;}
  busy=true;submit.disabled=true;close.disabled=true;message.textContent='Подождите…';
  try{
    const session=await fetch('/api/session',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!session.ok)throw new Error('Не удалось связаться с сервером. Повторите попытку.');
    const identity=await session.json();
    const response=await fetch(token?'/api/auth/reset-password':'/api/auth/forgot-password',{
      method:'POST',headers:{'Content-Type':'application/json','X-App-Token':identity.token},
      body:JSON.stringify(token?{...values,token}:{email:values.email}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Не удалось восстановить пароль.');
    if(token){
      token='';form.reset();passwordFields.hidden=true;submit.hidden=true;
      message.textContent='Пароль изменён. Войдите в аккаунт с новым паролем.';
      close.textContent='Перейти ко входу';
      close.onclick=()=>location.assign('/');
    }else message.textContent=result.message;
  }catch(error){message.textContent=error.name==='TimeoutError'
    ?'Ответ задерживается. Если вы сохраняли пароль, попробуйте войти с новым. Иначе повторите запрос позже.'
    :error.message||'Не удалось связаться с сервером.';
  }finally{busy=false;submit.disabled=false;close.disabled=false;}
});
