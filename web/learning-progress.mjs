const previous=new WeakMap();
export function renderLearningProgress(root,progress,onPractice){
  if(!root)return;
  const signature=JSON.stringify(progress||null);
  if(previous.get(root)===signature)return;
  previous.set(root,signature);root.replaceChildren();
  const element=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
  root.append(element('h4','Как меняется помощь в заданиях'));
  root.append(element('p','За последние 30 дней · по данным занятий в Адым','helper'));
  if(!progress?.tracked_tasks){root.append(element('p','После новых заданий здесь появятся темы, результаты и следующий шаг для повторения. Старые задания без подробных событий не оцениваем заново.','helper'));return;}
  const week=progress.current_week,old=progress.previous_week;
  root.append(element('p',`За 7 дней завершено: ${week.completed}. С минимумом помощи: ${week.light_support}.`,'progress-week'));
  root.append(element('p',progress.comparison_ready
    ?`Доля заданий с минимумом помощи: ${week.light_support_percent}% за последние 7 дней, ${old.light_support_percent}% за предыдущие 7 дней. Это наблюдение за использованием подсказок, а не оценка знаний.`
    :'Для сравнения недель нужно хотя бы по 3 завершённых задания в каждой.','helper'));
  const list=element('div',undefined,'progress-topics');
  for(const topic of progress.topics){
    const row=element('article',undefined,'progress-topic');row.append(element('strong',topic.title));
    row.append(element('p',`Заданий: ${topic.tasks} · решено: ${topic.solved} · с минимумом помощи: ${topic.light_support}`));
    row.append(element('small',`Полное объяснение: ${topic.explained} · несовпадений ответа с планом: ${topic.incorrect_attempts} · уточнений: ${topic.clarifications??0} · оставлено: ${topic.switched}`));list.append(row);
  }
  root.append(list);
  if(progress.recommendation){
    const r=progress.recommendation,card=element('div',undefined,'progress-next');
    card.append(element('strong',`Что попробовать дальше: ${r.topic}`),element('p',r.text));
    if(r.question){const button=element('button','Подготовить короткое задание','secondary');button.type='button';button.addEventListener('click',()=>{if(onPractice?.(r.question)!==false)button.textContent='Задание подготовлено · начните занятие';});card.append(button);}
    root.append(card);
  }
  root.append(element('p',progress.note,'helper'));
  if(progress.untracked_tasks)root.append(element('p',`Без полной детализации новой версии: ${progress.untracked_tasks}. Итоги этих заданий сохранены, но в сравнение помощи они не включены.`,'helper'));
}
