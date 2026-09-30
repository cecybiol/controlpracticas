// Ejecutar instalarAvisos una vez; después procesarControlPracticas aproximadamente cada hora.
var CP_SETTINGS={projectId:'control-practicas-f7b5a',folderId:'16RT_GoWf_acRnlvK1o995H3_6Aul0kla',maxEmails:20,maxSync:30,maxRequests:5,maxMillis:240000};

function instalarAvisos(){
 comprobarConexion();
 ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='procesarControlPracticas').forEach(t=>ScriptApp.deleteTrigger(t));
 ScriptApp.newTrigger('procesarControlPracticas').timeBased().everyHours(1).create();
 console.log('Disparador instalado: aproximadamente cada hora. No envía correos en esta instalación.');
}
function detenerAvisos(){
 ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='procesarControlPracticas').forEach(t=>ScriptApp.deleteTrigger(t));
 console.log('Disparador retirado.');
}
function comprobarConexion(){
 const fs=CPFirestore(CP_SETTINGS.projectId),config=fs.get('configuracion/notificaciones');
 const folder=DriveApp.getFolderById(config&&config.data.acuerdosFolderId||CP_SETTINGS.folderId);
 console.log(JSON.stringify({conexion:'correcta',carpeta:folder.getName(),destinatariosDisponibles:MailApp.getRemainingDailyQuota(),zona:CPDomain.TIME_ZONE}));
}
function CPkey(p,a){
 const value=JSON.stringify([p.id,p.alumnoId,a.email,p.fecha,p.fechaFin||'',p.lugar,p.sector,p.horaInicio||'',p.horaFin||'',p.acuerdoNombre||'',p.tipo||'',p.tutorEmail||'',p.tutorResponsable||'',p.contacto||'']);
 return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8).map(n=>('0'+(n&255).toString(16)).slice(-2)).join('');
}
function CPconfig(c){
 const config=Object.assign({diasAviso:7,horaEnvio:'08:00',automatico:false,acuerdosFolderId:CP_SETTINGS.folderId},c||{});
 CPDomain.notificationCandidates([],config);
 if(!/^[a-zA-Z0-9_-]+$/.test(config.acuerdosFolderId))throw new Error('Carpeta de acuerdos inválida.');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.horaEnvio))throw new Error('Horario inválido.');
 if(config.ccEmail&&!CPDomain.validEmail(config.ccEmail))throw new Error('Correo de copia inválido.');
 return config;
}
function CPfiles(folderId){
 const files=[],seen={};
 function walk(folder){
  const id=folder.getId();if(seen[id])return;
  if(Object.keys(seen).length>=100)throw new Error('Acuerdos supera 100 subcarpetas.');seen[id]=true;
  const it=folder.getFiles();while(it.hasNext()){const file=it.next();if(files.length>=3000)throw new Error('Acuerdos supera 3000 archivos.');files.push({id:file.getId(),name:file.getName(),mimeType:file.getMimeType()});}
  const children=folder.getFolders();while(children.hasNext())walk(children.next());
 }
 walk(DriveApp.getFolderById(folderId));return files;
}
function CPpdf(file){
 const blob=DriveApp.getFileById(file.id).getBlob(),bytes=blob.getBytes();
 if(bytes.length<5||String.fromCharCode.apply(null,bytes.slice(0,5))!=='%PDF-')throw new Error('El archivo no contiene un PDF válido.');
 if(bytes.length>8*1024*1024)throw new Error('El acuerdo supera 8 MiB.');
 return blob.setName(file.name);
}
function CPinspect(p,a,config,files,now){
 if(!a||a.archivado||!CPDomain.validEmail(a.email))throw new Error('Alumno archivado o sin correo válido.');
 if(!p.sector)throw new Error('Falta Sector/Carrera.');
 const cc=config.ccEmail||p.tutorEmail||'';if(cc&&!CPDomain.validEmail(cc))throw new Error('Correo de copia inválido.');
 const file=CPDomain.selectAgreement(files,a,p),blob=CPpdf(file);
 return {p,a,key:CPkey(p,a),file,blob,cc,destinatarios:1+(cc&&cc.trim().toLowerCase()!==a.email.trim().toLowerCase()?1:0)};
}
function CPsummary(item,state,detail){
 return {practicaId:item.p.id,alumnoId:item.a.id,lugar:item.p.lugar,sector:item.p.sector,destinatario:item.a.email,acuerdo:item.file.name,estado:state,detalle:detail||''};
}
function CPrecord(fs,item,state,detail,origin){
 const data=Object.assign(CPsummary(item,state,detail),{acuerdoId:item.file.id,origen:origin,fechaEnvio:new Date().toISOString()});
 const writes=[fs.write('notificaciones_envios/'+item.key,data,null,true),fs.write('notificaciones_log/'+Utilities.getUuid(),data)];
 if(state==='enviado')writes.push(fs.write('practicas/'+item.p.id,{avisoAutomaticoEnviado:true,fechaAviso:data.fechaEnvio,acuerdoEnviado:item.file.id},null,true));
 fs.commit(writes);
}
function CPclaim(fs,item,config,now){
 return fs.transaction(tx=>{
  const previous=tx.get('notificaciones_envios/'+item.key),p=tx.get('practicas/'+item.p.id),a=tx.get('alumnos/'+item.a.id);
  if(!p||!a||a.data.archivado||CPkey(Object.assign({id:p.id},p.data),a.data)!==item.key||!CPDomain.notificationCandidates([Object.assign({id:p.id},p.data)],config,now).length)return false;
  if(previous&&!['error','bloqueado'].includes(previous.data.estado))return false;
  tx.set('notificaciones_envios/'+item.key,{practicaId:item.p.id,alumnoId:item.a.id,estado:'enviando',fechaInicio:new Date().toISOString(),acuerdo:item.file.name});return true;
 });
}
function CPsend(fs,item,config,now,origin,budget){
 if(budget.sent>=CP_SETTINGS.maxEmails||Date.now()-budget.start>CP_SETTINGS.maxMillis)return {estado:'pendiente',detalle:'Límite de ejecución: queda pendiente.'};
 if(MailApp.getRemainingDailyQuota()<item.destinatarios)return {estado:'pendiente',detalle:'Cuota diaria insuficiente: queda pendiente sin enviar.'};
 if(!CPclaim(fs,item,config,now))return {estado:'omitido',detalle:'Ya enviado o intento pendiente de revisión.'};
 budget.sent++;
 const p=item.p,a=item.a;
 const body=['Hola '+a.nombre+' '+a.apellido+',','Te enviamos el acuerdo de tu práctica profesionalizante.','Lugar: '+p.lugar,'Sector/Carrera: '+p.sector,'Fecha: '+p.fecha+(p.fechaFin&&p.fechaFin!==p.fecha?' a '+p.fechaFin:''),'Horario: '+(p.horaInicio||'')+' - '+(p.horaFin||''),'Tutor: '+(p.tutorResponsable||''),'Contacto: '+(p.contacto||''),config.mensaje||'','Se adjunta tu acuerdo individual en PDF.'].join('\n');
 try{const mail={to:a.email.trim(),subject:'Acuerdo de práctica '+p.lugar+' '+p.sector,body,attachments:[item.blob],name:'Prácticas Profesionalizantes — Escuela Técnica N° 10'};if(item.cc&&item.destinatarios===2)mail.cc=item.cc;MailApp.sendEmail(mail);}
 catch(err){CPrecord(fs,item,'requiere_revision','No se pudo confirmar el envío; revisar la cuenta remitente antes de reintentar.',origin);return {estado:'requiere_revision',detalle:'Envío incierto; no se reintenta automáticamente.'};}
 // Fallo de persistencia después del envío mantiene el bloqueo "enviando".
 CPrecord(fs,item,'enviado','Aceptado por MailApp; recepción en bandeja no confirmada.',origin);
 return {estado:'enviado',detalle:'Aceptado por MailApp.'};
}
function CPbatch(fs,practices,students,config,now,files,ids,dryRun,budget,origin){
 if(files.error)throw new Error(files.error);
 const byId={};students.forEach(a=>byId[a.id]=a);
 const details=[];
 const candidates=CPDomain.notificationCandidates(practices,config,now);
 if(ids)ids.filter(id=>!candidates.some(p=>p.id===id)).forEach(id=>details.push({practicaId:id,estado:'omitido',detalle:'La práctica cambió, ya fue avisada o está fuera del rango de fechas.'}));
 candidates.filter(p=>!ids||ids.includes(p.id)).forEach(p=>{
  if(Date.now()-budget.start>CP_SETTINGS.maxMillis||(!dryRun&&budget.sent>=CP_SETTINGS.maxEmails)){details.push({practicaId:p.id,lugar:p.lugar,sector:p.sector,estado:'pendiente',detalle:'Límite de ejecución.'});return;}
  let item;
  try{item=CPinspect(p,byId[p.alumnoId],config,files,now);}
  catch(err){details.push({practicaId:p.id,lugar:p.lugar,sector:p.sector,estado:'bloqueado',detalle:err.message});return;}
  const result=dryRun?{estado:'listo'}:CPsend(fs,item,config,now,origin,budget);
  details.push(CPsummary(item,result.estado,result.detalle));
 });
 return {detalles:details,enviados:details.filter(d=>d.estado==='enviado').length,errores:details.filter(d=>['bloqueado','requiere_revision'].includes(d.estado)).length,pendientes:details.filter(d=>d.estado==='pendiente').length,omitidos:details.filter(d=>d.estado==='omitido').length,listos:details.filter(d=>d.estado==='listo').length,bloqueados:details.filter(d=>d.estado==='bloqueado').length};
}
function CPsync(fs,practices,now,budget){
 const props=PropertiesService.getScriptProperties(),since=props.getProperty('CP_ULTIMA_FECHA_ASISTENCIA')||CPDomain.addDays(now.date,-1);
 const records=fs.list('asistencias',['fecha','GREATER_THAN_OR_EQUAL',since]).map(r=>Object.assign({id:r.id},r.data));
 let operations=0,incomplete=false;
 for(const original of practices){
  if(original.archivada||original.estado==='cancelada'||CPDomain.manualHours(original))continue;
  for(const date of CPDomain.datesFor(original).filter(d=>d>=since&&CPDomain.finished(d,original,now))){
   if(operations>=CP_SETTINGS.maxSync||Date.now()-budget.start>CP_SETTINGS.maxMillis){incomplete=true;break;}
   const id=CPDomain.attendanceId(original.id,date),current=records.find(r=>r.id===id);
   const legacy=records.filter(r=>!r.duplicadaEn&&r.id!==id&&r.fecha===date&&CPDomain.attendanceMatches(r,original,practices));
   if(current&&!current.fueraCronograma&&!legacy.length&&current.alumnoId===original.alumnoId&&current.lugar===original.lugar&&current.tipo===(original.tipo||'interna')&&(current.origen!=='automatico'||current.editado||current.confirmado||(current.horaEntrada===original.horaInicio&&current.horaSalida===original.horaFin)))continue;
   if(records.some(r=>!r.practicaId&&!r.duplicadaEn&&r.fecha===date&&r.alumnoId===original.alumnoId&&CPDomain.normalize(r.lugar)===CPDomain.normalize(original.lugar)&&!CPDomain.attendanceMatches(r,original,practices)))continue;
   fs.transaction(tx=>{
    const parent=tx.get('practicas/'+original.id);if(!parent)return;
    const p=Object.assign({id:parent.id},parent.data);if(p.archivada||p.estado==='cancelada'||CPDomain.manualHours(p)||!CPDomain.datesFor(p).includes(date))return;
    const canonical=tx.get('asistencias/'+id),old=legacy.map(r=>tx.get('asistencias/'+r.id));
    const existing=[canonical].concat(old).filter(r=>r&&!r.data.duplicadaEn).map(r=>r.data),chosen=CPDomain.chooseAttendance(existing);
    let data=chosen.conflict?{estado:'pendiente',presente:false,conflicto:true,origen:'revision',observaciones:'Registros contradictorios: revisar.'}:chosen.record?Object.assign({},chosen.record):{estado:'presente',presente:true,origen:'automatico',observaciones:'Generado por el cronograma al finalizar la jornada.'};
    if(data.origen==='automatico'&&!data.editado&&!data.confirmado&&!data.suprimido){data.horaEntrada=p.horaInicio||'';data.horaSalida=p.horaFin||'';}
    Object.assign(data,{alumnoId:p.alumnoId,practicaId:p.id,fecha:date,lugar:p.lugar||'',tipo:p.tipo||'interna',fueraCronograma:false});
    tx.set('asistencias/'+id,data);old.filter(r=>r&&!r.data.duplicadaEn).forEach(r=>tx.update(r.path,{duplicadaEn:id}));
   });operations++;
  }
  if(incomplete)break;
 }
 // Sólo invalidar registros recientes; la sincronización docente conserva la revisión del historial completo.
 const byId={};practices.forEach(p=>byId[p.id]=p);
 for(const r of records){if(operations>=CP_SETTINGS.maxSync)break;const p=byId[r.practicaId];if(!r.practicaId||r.duplicadaEn||r.fueraCronograma)continue;
  if(!p||p.archivada||p.estado==='cancelada'||r.alumnoId!==p.alumnoId||!CPDomain.datesFor(p).includes(r.fecha)){fs.set('asistencias/'+r.id,{fueraCronograma:true},true);operations++;}
 }
 if(!incomplete)props.setProperty('CP_ULTIMA_FECHA_ASISTENCIA',now.date);
 return {jornadasActualizadas:operations,pendientes:incomplete};
}
function CPparticular(fs,request,budget){
 const d=request.data;
 if(!CPDomain.validEmail(d.email)||!d.nombre||!d.asunto||!d.mensaje)throw new Error('Datos del correo particular incompletos.');
 if(MailApp.getRemainingDailyQuota()<1||budget.sent>=CP_SETTINGS.maxEmails)return {pendientes:1,detalles:[{estado:'pendiente',detalle:'Cuota insuficiente.'}]};
 budget.sent++;
 try{MailApp.sendEmail({to:d.email,subject:d.asunto,body:d.mensaje,name:'Prácticas Profesionalizantes — Escuela Técnica N° 10'});}
 catch(_){return {errores:1,detalles:[{estado:'requiere_revision',detalle:'Revisar la cuenta remitente antes de reintentar.'}]};}
 fs.set('notificaciones_log/'+Utilities.getUuid(),{tipo:'correo_particular',destinatario:d.email,nombreDestinatario:d.nombre,asunto:d.asunto,origen:'manual',estado:'enviado',detalle:'Aceptado por MailApp.',fechaEnvio:new Date().toISOString()});
 return {enviados:1,detalles:[{estado:'enviado',detalle:'Aceptado por MailApp.'}]};
}
function CPrequest(fs,request,practices,students,config,now,files,budget){
 const data=request.data,profile=fs.get('usuarios/'+data.solicitanteUid);
 if(!profile||!['admin','tutor'].includes(profile.data.rol)){fs.set(request.path,{estado:'error',detalle:'El solicitante ya no tiene rol docente.'},true);return;}
 if(!['comprobar','enviar','particular'].includes(data.accion)){fs.set(request.path,{estado:'error',detalle:'Acción inválida.'},true);return;}
 if(data.accion==='enviar'&&(!Array.isArray(data.practicaIds)||!data.practicaIds.length||data.practicaIds.length>100||data.practicaIds.some(id=>typeof id!=='string'||id.includes('/')))){fs.set(request.path,{estado:'error',detalle:'Selección inválida.'},true);return;}
 fs.commit([fs.write(request.path,{estado:'procesando',inicio:new Date().toISOString()},{updateTime:request.updateTime},true)]);
 try{
  let result;
  if(data.accion==='particular')result=CPparticular(fs,request,budget);
  else{
   const chosen=Object.assign({},config);if(data.cc!==undefined){if(data.cc&&!CPDomain.validEmail(data.cc))throw new Error('Copia inválida.');chosen.ccEmail=data.cc;}chosen.mensaje=String(data.mensaje||'').slice(0,5000);
   result=CPbatch(fs,practices,students,chosen,now,files,data.practicaIds,data.accion==='comprobar',budget,'manual');
   if(data.accion==='comprobar')result.config={horaEnvio:config.horaEnvio,zona:CPDomain.TIME_ZONE,cuotaDisponible:MailApp.getRemainingDailyQuota(),ultimoControl:config.ultimoControl||null};
  }
  fs.set(request.path,{estado:result.pendientes?'pendiente':'completado',resultado:result,fin:new Date().toISOString()},true);
 }catch(err){fs.set(request.path,{estado:'requiere_revision',detalle:err.message,fin:new Date().toISOString()},true);}
}
function procesarControlPracticas(){
 const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
 const budget={start:Date.now(),sent:0},fs=CPFirestore(CP_SETTINGS.projectId),now=CPDomain.clock();
 let status={fecha:new Date().toISOString(),zona:CPDomain.TIME_ZONE,motor:'apps_script',estado:'sin_envios'};
 try{
  const config=CPconfig((fs.get('configuracion/notificaciones')||{data:{}}).data);
  const requests=fs.list('notificaciones_solicitudes',['estado','EQUAL','pendiente'],CP_SETTINGS.maxRequests);
  const practices=fs.list('practicas').map(r=>Object.assign({id:r.id},r.data));
  status.asistencia=CPsync(fs,practices,now,budget);
  const automatic=config.automatico&&now.time>=config.horaEnvio;
  if(requests.length||automatic){
   const students=fs.list('alumnos').map(r=>Object.assign({id:r.id},r.data));
   let files=[];if(automatic||requests.some(r=>r.data.accion!=='particular')){try{files=CPfiles(config.acuerdosFolderId);}catch(err){files.error=err.message;}}
   for(const request of requests){if(Date.now()-budget.start>CP_SETTINGS.maxMillis)break;CPrequest(fs,request,practices,students,config,now,files,budget);}
   if(automatic&&Date.now()-budget.start<=CP_SETTINGS.maxMillis)status=Object.assign(status,CPbatch(fs,practices,students,config,now,files,null,false,budget,'programado'));
  }
  status.estado='completado';status.cuotaDisponible=MailApp.getRemainingDailyQuota();
 }catch(err){status.estado='error';status.detalle=err.message;console.error(err.message);}
 finally{try{fs.set('configuracion/notificaciones',{ultimoControl:status},true);}finally{lock.releaseLock();}}
 return status;
}
