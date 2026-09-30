import {selectAgreement, expectedAgreementNames, validEmail, notificationCandidates, clock} from './domain.mjs';
import {createHash} from 'node:crypto';

export function noticeKey(p,a){
 return createHash('sha256').update(JSON.stringify([p.id,p.alumnoId,a.email,p.fecha,p.fechaFin||'',p.lugar,p.sector,p.horaInicio||'',p.horaFin||'',p.acuerdoNombre||'',p.tipo||'',p.tutorEmail||'',p.tutorResponsable||'',p.contacto||''])).digest('hex');
}
export function validateConfig(config){
 if(!config.acuerdosFolderId||!/^[a-zA-Z0-9_-]+$/.test(config.acuerdosFolderId))throw new Error('Falta configurar la carpeta de acuerdos PDF.');
 if(config.adjuntosConfigurados!==true)throw new Error('Confirmá la configuración de Variable Attachment adjunto_acuerdo en EmailJS antes de habilitar envíos.');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.horaEnvio||''))throw new Error('El horario programado no es válido.');
 if(config.ccEmail&&!validEmail(config.ccEmail))throw new Error('El correo de copia configurado es inválido.');
}
export function validatePdf(bytes,maxBytes=8*1024*1024){
 const data=Buffer.from(bytes);
 if(data.length<5||data.subarray(0,5).toString()!=='%PDF-')throw new Error('El archivo de Drive no contiene un PDF válido.');
 if(data.length>maxBytes)throw new Error('El acuerdo supera el límite de tamaño configurado.');
 return data;
}
export async function inspectNotices({practices,students,config,listFiles,download,now=clock(),ids}){
 validateConfig(config);
 const candidates=notificationCandidates(practices,config,now).filter(p=>!ids||ids.includes(p.id));
 const files=await listFiles(config.acuerdosFolderId);
 const byId=new Map(students.map(a=>[a.id,a]));const details=[];
 for(const p of candidates){
  const a=byId.get(p.alumnoId);let result={practicaId:p.id,alumnoId:p.alumnoId,lugar:p.lugar,sector:p.sector,estado:'listo'};
  try{
   if(!a||a.archivado||!validEmail(a.email))throw new Error('El alumno no tiene un correo válido o está archivado.');
   if(!p.sector)throw new Error('Falta el sector de la práctica para seleccionar el acuerdo.');
   const file=selectAgreement(files,a,p);const bytes=validatePdf(await download(file.id));
   result={...result,destinatario:a.email,acuerdo:file.name,acuerdoId:file.id,bytes:bytes.length,key:noticeKey(p,a),params:emailParams(p,a,config,bytes,file.name)};
  }catch(err){result.estado='bloqueado';result.detalle=err.message;result.nombresEsperados=a?expectedAgreementNames(a,p):[];}
  details.push(result);
 }
 return details;
}
function emailParams(p,a,config,pdf,name){
 const date=p.fechaFin&&p.fechaFin!==p.fecha?`${p.fecha} a ${p.fechaFin}`:p.fecha;
 const cc=config.ccEmail||p.tutorEmail||'';if(cc&&!validEmail(cc))throw new Error('El correo de copia del tutor es inválido.');
 return {to_email:a.email.trim(),to_name:`${a.nombre} ${a.apellido}`,name:a.nombre||'',apellido:a.apellido||'',lugar:p.lugar||'',sector:p.sector||'',fecha:date,horario:`${p.horaInicio||''} - ${p.horaFin||''}`,tutor:p.tutorResponsable||'',contacto:p.contacto||'',cc_email:cc,mensaje_adicional:config.mensaje||'',asunto:`Acuerdo de práctica ${p.lugar} ${p.sector}`,adjunto_acuerdo:`data:application/pdf;base64,${pdf.toString('base64')}`,adjunto_nombre:name};
}
export async function dispatchNotices({details,claim,recordResult,send,delay=()=>new Promise(r=>setTimeout(r,1100)),maxCount=20}){
 let enviados=0,errores=0,omitidos=0,attempted=0;const results=[];
 for(const item of details){
  if(item.estado==='listo' && attempted>=maxCount){omitidos++;continue;}
  if(item.estado!=='listo'){errores++;await recordResult(item,'bloqueado',item.detalle);results.push({...publicDetail(item),estado:'bloqueado'});continue;}
  if(!await claim(item)){omitidos++;results.push({...publicDetail(item),estado:'omitido',detalle:'Ya enviado o pendiente de confirmar un intento anterior.'});continue;}
  attempted++;
  let state='enviado',reason='Aceptado por EmailJS; recepción en bandeja no confirmada';
  try{await send(item.params);enviados++;}
  catch(err){state=err.definiteFailure?'error':'requiere_revision';reason=err.message;errores++;}
  // Si la persistencia falla después del envío, el claim permanece bloqueado. No reenviar automáticamente.
  await recordResult(item,state,reason);
  results.push({...publicDetail(item),estado:state,detalle:reason});await delay();
 }
 return {enviados,errores,omitidos,pendientes:details.filter(d=>d.estado==='listo').length-results.filter(d=>d.estado!=='bloqueado').length,detalles:results};
}
export function publicDetail({params,...data}){return data;}
