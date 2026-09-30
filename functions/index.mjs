import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {defineSecret,defineString} from 'firebase-functions/params';
import {GoogleAuth} from 'google-auth-library';
import {clock,TIME_ZONE,notificationCandidates,validEmail} from './domain.mjs';
import {synchronizeAttendance} from './attendance-store.mjs';
import {inspectNotices,dispatchNotices,publicDetail,validateConfig,noticeKey} from './notification-engine.mjs';

initializeApp();const db=getFirestore();
const privateKey=defineSecret('EMAILJS_PRIVATE_KEY');
const publicKey=defineString('EMAILJS_PUBLIC_KEY',{default:'3TNv9_jszGm9ceZDv'});
const serviceId=defineString('EMAILJS_SERVICE_ID',{default:'service_1uto54c'});
const templateId=defineString('EMAILJS_TEMPLATE_ID',{default:'template_kchlwi9'});
const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/drive.readonly']});
const region='southamerica-east1';
const rows=snap=>snap.docs.map(d=>({id:d.id,...d.data()}));
async function dataset(){
 const [p,a,r,c]=await Promise.all([db.collection('practicas').get(),db.collection('alumnos').get(),db.collection('asistencias').get(),db.doc('configuracion/notificaciones').get()]);
 return {practices:rows(p),students:rows(a),records:rows(r),config:{diasAviso:3,horaEnvio:'08:00',acuerdosFolderId:'16RT_GoWf_acRnlvK1o995H3_6Aul0kla',...(c.data()||{})}};
}
const syncApi={doc:(_,collection,id)=>db.collection(collection).doc(id),runTransaction:(_,callback)=>db.runTransaction(tx=>callback({get:async ref=>{const s=await tx.get(ref);return {id:s.id,ref:s.ref,exists:()=>s.exists,data:()=>s.data()};},set:(ref,data)=>tx.set(ref,data),update:(ref,data)=>tx.update(ref,data)}))};
async function driveRequest(url,options={}){
 const client=await auth.getClient();return client.request({url,...options});
}
async function listFiles(folderId){
 const files=[],visited=new Set();
 async function walk(id){
  if(visited.has(id))return;if(visited.size>=500)throw new Error('La carpeta de acuerdos supera 500 subcarpetas.');visited.add(id);
  let token='';
  do{
   const params=new URLSearchParams({q:`'${id}' in parents and trashed=false`,fields:'nextPageToken,files(id,name,mimeType)',pageSize:'1000',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});if(token)params.set('pageToken',token);
   const {data}=await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`);
   for(const file of data.files||[])if(file.mimeType==='application/vnd.google-apps.folder')await walk(file.id);else files.push(file);
   token=data.nextPageToken||'';
  }while(token);
 }
 await walk(folderId);return files;
}
async function download(id){
 const {data}=await driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,{responseType:'arraybuffer',maxContentLength:8*1024*1024});return Buffer.from(data);
}
async function send(params){
 let response;
 try{response=await fetch('https://api.emailjs.com/api/v1.0/email/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service_id:serviceId.value(),template_id:templateId.value(),user_id:publicKey.value(),accessToken:privateKey.value(),template_params:params}),signal:AbortSignal.timeout(25000)});}
 catch(_){throw new Error('No se pudo confirmar si EmailJS recibió el correo. Revisar su historial antes de reintentar.');}
 if(!response.ok){const error=new Error(`EmailJS rechazó el envío con estado HTTP ${response.status}. Revisar configuración, plantilla y cuota.`);error.definiteFailure=response.status>=400&&response.status<500;throw error;}
}
async function claim(item){
 const ref=db.doc(`notificaciones_envios/${item.key}`);
 return db.runTransaction(async tx=>{
  const [s,p,a]=await Promise.all([tx.get(ref),tx.get(db.doc(`practicas/${item.practicaId}`)),tx.get(db.doc(`alumnos/${item.alumnoId}`))]);
  if(!p.exists||!a.exists||a.data().archivado||noticeKey({id:p.id,...p.data()},a.data())!==item.key||!notificationCandidates([{id:p.id,...p.data()}],{diasAviso:90}).length||a.data().email!==item.destinatario)return false;
  if(s.exists&&s.data().estado!=='error'&&s.data().estado!=='bloqueado')return false;
  tx.set(ref,{practicaId:item.practicaId,alumnoId:item.alumnoId,destinatario:item.destinatario,acuerdoId:item.acuerdoId,acuerdo:item.acuerdo,estado:'enviando',inicio:new Date().toISOString()});return true;
 });
}
async function recordResult(item,state,reason,origin='programado'){
 const batch=db.batch(),data={practicaId:item.practicaId,alumnoId:item.alumnoId,destinatario:item.destinatario||'',acuerdo:item.acuerdo||'',acuerdoId:item.acuerdoId||'',origen:origin,estado:state,detalle:reason,fechaEnvio:new Date().toISOString()};
 batch.set(db.collection('notificaciones_log').doc(),data);
 if(item.key)batch.set(db.doc(`notificaciones_envios/${item.key}`),{...data},{merge:true});
 if(state==='enviado')batch.update(db.doc(`practicas/${item.practicaId}`),{avisoAutomaticoEnviado:true,fechaAviso:data.fechaEnvio,acuerdoEnviado:item.acuerdoId});
 await batch.commit();
}
async function runNotices(data,{ids,dryRun=false,origin='programado',cc,mensaje}={}){
 const config={...data.config};if(cc!==undefined){if(cc&&!validEmail(cc))throw new Error('Correo de copia inválido.');config.ccEmail=cc;}if(mensaje!==undefined)config.mensaje=String(mensaje).slice(0,5000);
 const details=await inspectNotices({...data,config,listFiles,download,ids});
 if(dryRun)return {detalles:details.map(publicDetail),config:{automatico:!!config.automatico,horaEnvio:config.horaEnvio,zona:TIME_ZONE,adjuntosConfigurados:config.adjuntosConfigurados===true,ultimoControl:config.ultimoControl||null},listos:details.filter(d=>d.estado==='listo').length,bloqueados:details.filter(d=>d.estado==='bloqueado').length};
 return dispatchNotices({details,claim,send,recordResult:(item,state,reason)=>recordResult(item,state,reason,origin)});
}
export const gestionarAvisos=onCall({region,secrets:[privateKey],timeoutSeconds:540,memory:'512MiB'},async request=>{
 if(!request.auth)throw new HttpsError('unauthenticated','Iniciá sesión.');
 const profile=await db.doc(`usuarios/${request.auth.uid}`).get();
 if(!['admin','tutor'].includes(profile.data()?.rol))throw new HttpsError('permission-denied','Se requiere rol docente.');
 const data=await dataset();const {accion,practicaIds,cc,mensaje}=request.data||{};
 if(accion!=='comprobar'&&accion!=='enviar')throw new HttpsError('invalid-argument','Acción inválida.');
 if(accion==='enviar'&&(!Array.isArray(practicaIds)||!practicaIds.length||practicaIds.length>100||practicaIds.some(id=>typeof id!=='string'||id.includes('/'))))throw new HttpsError('invalid-argument','Seleccioná entre una y cien prácticas.');
 try{return await runNotices(data,{ids:accion==='enviar'?practicaIds:undefined,dryRun:accion==='comprobar',origin:'manual',cc,mensaje});}
 catch(err){throw new HttpsError('failed-precondition',err.message||'No se pudo comprobar el envío.');}
});
export const procesarJornadasYAvisos=onSchedule({region,schedule:'every 15 minutes',timeZone:TIME_ZONE,secrets:[privateKey],timeoutSeconds:540,memory:'512MiB',maxInstances:1,retryCount:0},async()=>{
 const data=await dataset();const now=clock();let status={fecha:new Date().toISOString(),zona:TIME_ZONE,estado:'sin_envios'};
 try{
  await synchronizeAttendance({db,api:syncApi,practices:data.practices,records:data.records,now});
  if(data.config.automatico){validateConfig(data.config);if(now.time>=data.config.horaEnvio){status={...status,estado:'completado',...await runNotices(data)};}}
 }catch(err){status={...status,estado:'error',detalle:err.message};}
 await db.doc('configuracion/notificaciones').set({ultimoControl:status},{merge:true});
});
