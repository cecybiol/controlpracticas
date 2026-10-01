import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const host=process.env.FIRESTORE_EMULATOR_HOST;if(!host)throw Error('Ejecutar dentro del emulador de Firestore.');
const ctx=vm.createContext({ScriptApp:{getOAuthToken:()=> 'owner'},UrlFetchApp:{fetch:(url,opt)=>{
 const args=['--max-time','10','-sS','-X',opt.method.toUpperCase(),'-H','Authorization: Bearer owner','-H','Content-Type: application/json'];
 if(opt.payload)args.push('--data-binary',opt.payload);args.push('-w','\n%{http_code}',url.replace('https://firestore.googleapis.com','http://'+host));
 const r=spawnSync('curl',args,{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);const i=r.stdout.lastIndexOf('\n'),body=r.stdout.slice(0,i),status=Number(r.stdout.slice(i+1));
 return {getResponseCode:()=>status,getContentText:()=>body};
}}});
vm.runInContext(fs.readFileSync('apps-script/Firestore.gs','utf8'),ctx);const db=ctx.CPFirestore('demo-controlpracticas');
test('REST real del emulador guarda y lee arrays y campos anidados',()=>{db.set('rest_pruebas/a',{nombre:'Ana',dias:[1,3],horas:4.5,activo:true,datos:{estado:'listo'}});const r=db.get('rest_pruebas/a');assert.equal(r.data.nombre,'Ana');assert.deepEqual(Array.from(r.data.dias),[1,3]);assert.equal(r.data.horas,4.5);assert.equal(r.data.datos.estado,'listo');});
test('REST real conserva campos con updateMask',()=>{db.set('rest_pruebas/a',{nombre:'Melissa'},true);const r=db.get('rest_pruebas/a');assert.equal(r.data.nombre,'Melissa');assert.equal(r.data.activo,true);});
test('REST real consulta con filtro',()=>{const rows=db.list('rest_pruebas',['nombre','EQUAL','Melissa']);assert.equal(rows.length,1);assert.equal(rows[0].data.horas,4.5);});
test('REST real rechaza precondición de versión incorrecta',()=>assert.throws(()=>db.commit([db.write('rest_pruebas/a',{horas:999},{updateTime:'2000-01-01T00:00:00Z'},true)])));

test('REST real filtra ventanas con dos condiciones en servidor',()=>{db.set('rest_pruebas/futuro',{fecha:'2026-10-10',fechaFin:'2026-10-12'});db.set('rest_pruebas/actual',{fecha:'2026-09-28',fechaFin:'2026-10-02'});db.set('rest_pruebas/viejo',{fecha:'2026-08-01',fechaFin:'2026-08-10'});const rows=db.list('rest_pruebas',[['fechaFin','GREATER_THAN_OR_EQUAL','2026-09-30'],['fecha','LESS_THAN_OR_EQUAL','2026-09-30']]);assert.deepEqual(Array.from(rows,r=>r.id),['actual']);});
