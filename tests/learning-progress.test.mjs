import assert from 'node:assert/strict';
import test from 'node:test';
import {renderLearningProgress} from '../web/learning-progress.mjs';
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.events={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(){this.children=[];}
 addEventListener(name,fn){this.events[name]=fn;}
 set innerHTML(_){throw Error('Untrusted report data must remain text');}
}
globalThis.document={createElement:tag=>new Element(tag)};
const text=e=>[e.textContent,...e.children.map(text)].join(' ');
const progress=()=>({tracked_tasks:2,untracked_tasks:1,current_week:{completed:2,light_support:1},previous_week:{completed:0},comparison_ready:false,
 topics:[{title:'Дроби <script>',tasks:2,solved:1,light_support:1,explained:1,incorrect_attempts:2,switched:0}],
 recommendation:{topic:'Дроби',text:'Повторить дроби',question:'Сравни 1/2 и 1/4.'},note:'Это не оценка знаний'});
test('empty report never fabricates a progress score',()=>{const root=new Element('section');renderLearningProgress(root,{});assert.match(text(root),/После новых заданий/);assert.doesNotMatch(text(root),/%/);});
test('report shows observed topics and only prepares a practice question on explicit click',()=>{const root=new Element('section'),calls=[];renderLearningProgress(root,progress(),q=>calls.push(q));assert.equal(calls.length,0);assert.match(text(root),/Дроби <script>/);assert.match(text(root),/хотя бы по 3/);assert.match(text(root),/не оценка знаний/);const card=root.children.find(e=>e.className==='progress-next'),button=card.children.find(e=>e.tag==='button');button.events.click();assert.deepEqual(calls,['Сравни 1/2 и 1/4.']);});
test('unchanged polling preserves report controls instead of rebuilding focused buttons',()=>{const root=new Element('section');renderLearningProgress(root,progress());const original=root.children.at(-1);renderLearningProgress(root,progress());assert.equal(root.children.at(-1),original);});

test('updated parent report removes a recovered recommendation and shows clarification counts',()=>{
 const root=new Element('section'),initial=progress();renderLearningProgress(root,initial);
 assert.ok(root.children.some(e=>e.className==='progress-next'));
 const recovered=progress();recovered.recommendation=null;recovered.topics[0].clarifications=2;
 recovered.topics[0].light_support=2;renderLearningProgress(root,recovered);
 assert.ok(!root.children.some(e=>e.className==='progress-next'));
 assert.match(text(root),/уточнений: 2/);
});
test('practice confirmation stays visible across polling and cancellation leaves it unchanged',()=>{
 const root=new Element('section');let accepted=false;
 renderLearningProgress(root,progress(),()=>accepted);
 const button=root.children.find(e=>e.className==='progress-next').children.find(e=>e.tag==='button');
 button.events.click();assert.equal(button.textContent,'Подготовить короткое задание');
 accepted=true;button.events.click();renderLearningProgress(root,progress());
 assert.equal(button.textContent,'Задание подготовлено · начните занятие');
});
