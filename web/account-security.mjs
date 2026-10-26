const dialog=document.getElementById('changePasswordDialog');
const form=document.getElementById('changePasswordForm');
const message=document.getElementById('changePasswordMessage');
const closeButton=document.getElementById('closePasswordDialog');
let busy=false;
document.getElementById('changePasswordBtn').addEventListener('click',()=>{
  form.reset();message.hidden=true;dialog.showModal();
  document.getElementById('currentPassword').focus();
});
closeButton.addEventListener('click',()=>dialog.close());
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
dialog.addEventListener('close',()=>form.reset());
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const values=Object.fromEntries(new FormData(form));
  message.hidden=false;
  if(values.new_password!==values.confirmation){message.textContent='Пароли не совпадают.';return;}
  busy=true;const submit=form.querySelector('button[type="submit"]');
  submit.disabled=true;closeButton.disabled=true;message.textContent='Сохраняем…';
  try{
    const session=await fetch('/api/session',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!session.ok)throw new Error('Не удалось проверить вход. Повторите попытку.');
    const identity=await session.json();
    if(!identity.user)throw new Error('Войдите в аккаунт заново.');
    const response=await fetch('/api/account/password',{method:'POST',
      headers:{'X-App-Token':identity.token,'Content-Type':'application/json'},
      body:JSON.stringify(values),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Не удалось изменить пароль.');
    form.reset();message.textContent='Пароль изменён. Остальные сеансы завершены.';
  }catch(error){message.textContent=error.name==='TimeoutError'
    ?'Ответ сервера задерживается. Если пароль уже изменился, используйте новый пароль при входе.'
    :error.message||'Не удалось связаться с сервером.';
  }finally{busy=false;submit.disabled=false;closeButton.disabled=false;}
});
