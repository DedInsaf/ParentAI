// Each auth action obtains a fresh CSRF token, including on long-open pages.
export async function requestAuth(path, values, {fetcher=globalThis.fetch, timeout=path==='register'?45000:15000}={}) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  async function json(response){
    try{
      const data=await response.json();
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid response');
      return data;
    }
    catch{throw new Error('Сервис временно недоступен. Повторите попытку позже.');}
  }
  try{
    for(let attempt=0;attempt<2;attempt++){
      const session=await fetcher('/api/session',{cache:'no-store',signal:controller.signal});
      if(!session.ok)throw new Error('Не удалось подключиться к приложению. Повторите попытку.');
      const identity=await json(session);
      if(typeof identity.token!=='string'||!identity.token)throw new Error('Не удалось проверить соединение. Обновите страницу.');
      const response=await fetcher('/api/auth/'+path,{method:'POST',
        headers:{'X-App-Token':identity.token,'Content-Type':'application/json'},
        body:JSON.stringify(values),signal:controller.signal});
      const data=await json(response);
      // Only retry a CSRF rejection: the server has not performed the action.
      if(response.status===403&&data.error==='Invalid origin or token'&&attempt===0)continue;
      if(!response.ok){
        const error=new Error(data.error||'Не удалось выполнить действие. Повторите попытку.');
        error.verificationRequired=data.verification_required;error.email=data.email;
        throw error;
      }
      return data;
    }
  }catch(error){
    if(controller.signal.aborted)throw new Error(path==='register'
      ?'Ответ задерживается. Проверьте почту: регистрация могла завершиться. Если письма нет, попробуйте войти или запросить подтверждение повторно.'
      :'Ответ сервера задерживается. Повторите попытку позже.');
    if(error instanceof TypeError)throw new Error('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.');
    throw error;
  }finally{clearTimeout(timer);}
}
