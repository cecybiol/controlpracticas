import test from 'node:test';import assert from 'node:assert/strict';
import {clock,datesFor,calculatePractice,calendarState,duration,targets,selectAgreement,notificationCandidates,attendanceId,parseDays,validDate,practiceId} from '../js/domain.mjs';
import {synchronizeAttendance,validateAttendance} from '../js/attendance-store.mjs';
const now={date:'2026-09-29',time:'19:00'};
const practice=(patch={})=>({id:'p1',alumnoId:'a1',fecha:'2026-09-21',fechaFin:'2026-09-25',diasSemana:[1,2,3,4,5],horaInicio:'08:00',horaFin:'13:00',horasPorDia:5,horasTotales:25,tipo:'externa',estado:'programada',lugar:'ULP',sector:'Helpdesk',...patch});
const record=(fecha,estado='presente',patch={})=>({id:attendanceId('p1',fecha),practicaId:'p1',alumnoId:'a1',fecha,estado,presente:estado==='presente',horaEntrada:'08:00',horaSalida:'13:00',origen:'automatico',...patch});
const week=()=>datesFor(practice()).map(d=>record(d));
test('Un período pasado avanza a realizada aunque se guardó programada',()=>assert.equal(calendarState(practice(),now),'realizada'));
test('Una semana de cinco jornadas suma 25 horas externas',()=>assert.equal(calculatePractice(practice(),week(),undefined,now).horasRealizadas,25));
test('Una ausencia descuenta cinco horas',()=>{const rows=week();rows[2]=record(rows[2].fecha,'ausente_justificado');assert.equal(calculatePractice(practice(),rows,undefined,now).horasRealizadas,20)});
test('Una tardanza con entrada real de las nueve acredita cuatro horas',()=>assert.equal(calculatePractice(practice(),[record('2026-09-21','tardanza',{horaEntrada:'09:00'})],undefined,now).horasRealizadas,4));
test('Tardanza sin duración no acredita una jornada completa',()=>assert.equal(calculatePractice(practice(),[record('2026-09-21','tardanza',{horaEntrada:''})],undefined,now).horasRealizadas,0));
test('Un período 28 al 30 suma dos jornadas y conserva cinco futuras',()=>{const p=practice({fecha:'2026-09-28',fechaFin:'2026-09-30'}),v=calculatePractice(p,[record('2026-09-28'),record('2026-09-29'),record('2026-09-30')],undefined,now);assert.equal(v.estadoCalculado,'en_curso');assert.equal(v.horasRealizadas,10);assert.equal(v.horasPendientes,5);assert.equal(v.horasPlanificadas,15)});
test('Hoy antes de la salida no acredita horas ni cambia a realizada',()=>{const n={...now,time:'09:00'},p=practice({fecha:'2026-09-29',fechaFin:'2026-09-29'});assert.equal(calculatePractice(p,[record('2026-09-29')],undefined,n).horasRealizadas,0);assert.equal(calendarState(p,n),'en_curso')});
test('Canceladas no suman horas realizadas ni pendientes',()=>{const v=calculatePractice(practice({estado:'cancelada'}),week(),undefined,now);assert.equal(v.horasRealizadas,0);assert.equal(v.horasPendientes,0)});
test('Retirar una jornada impide acreditar sus horas',()=>assert.equal(calculatePractice(practice(),[record('2026-09-21','suprimido',{suprimido:true})],undefined,now).horasRealizadas,0));
test('Día reprogramado no acredita hasta registrar su nueva jornada',()=>assert.equal(calculatePractice(practice(),[record('2026-09-21','reprogramado')],undefined,now).horasRealizadas,0));
test('Un filtro de un día sólo suma ese día del período',()=>assert.equal(calculatePractice(practice(),week(),undefined,now,{desde:'2026-09-22',hasta:'2026-09-22'}).horasRealizadas,5));
test('Un total histórico manual no se prorratea sin desglose',()=>{const p=practice({estado:'realizada',modoHoras:'manual'}),v=calculatePractice(p,week(),undefined,now,{desde:'2026-09-22',hasta:'2026-09-22'});assert.equal(v.horasRealizadas,0);assert.equal(v.requiereDesglose,true)});
test('Total manual validado se conserva completo',()=>assert.equal(calculatePractice(practice({estado:'realizada',modoHoras:'manual',horasTotales:70}),[],undefined,now).horasRealizadas,70));
test('Total manual futuro no se acredita',()=>assert.equal(calculatePractice(practice({estado:'realizada',modoHoras:'manual',fechaFin:'2026-10-02'}),[],undefined,now).horasRealizadas,0));
test('Cronograma de dos días desconocidos exige revisión',()=>{const p=practice({diasSemana:[],diasPorSemana:2});assert.equal(calendarState(p,now),'pendiente_revision');assert.equal(datesFor(p).length,0)});
test('Martes a viernes calcula cuatro días exactos',()=>assert.equal(datesFor(practice({fecha:'2026-09-15',fechaFin:'2026-09-18'})).length,4));
test('Un excedente interno no oculta el déficit externo',()=>assert.deepEqual(targets({interna:150,externa:50},{interna:100,externa:100}),{pct:75,faltan:50}));
test('Fecha institucional no avanza a UTC entre las 21 y 24',()=>assert.equal(clock(new Date('2026-09-30T01:30:00Z')).date,'2026-09-29'));
test('Una fecha imposible es rechazada',()=>assert.equal(validDate('2026-02-31'),false));
test('Parseo de días admite español y tildes',()=>assert.deepEqual(parseDays('lun,mié,viernes'),[1,3,5]));
test('Salida anterior a entrada se rechaza',()=>assert.equal(duration('13:00','08:00'),null));
test('Asistencia ambigua sin práctica no suma a dos prácticas',()=>{const p=practice(),q=practice({id:'p2'}),r=record('2026-09-21','presente',{practicaId:undefined,lugar:'ULP',tipo:'externa'});assert.equal(calculatePractice(p,[r],[p,q],now).horasRealizadas,0)});
test('Corrección manual prevalece sobre presencia automática duplicada',()=>{const r=[record('2026-09-21'),record('2026-09-21','ausente_injustificado',{id:'legacy',origen:'manual'})];assert.equal(calculatePractice(practice(),r,undefined,now).horasRealizadas,0)});
test('Dos correcciones contradictorias no duplican horas',()=>{const r=[record('2026-09-21','presente',{origen:'manual'}),record('2026-09-21','ausente_justificado',{id:'other',origen:'manual'})],v=calculatePractice(practice(),r,undefined,now);assert.equal(v.horasRealizadas,0);assert.equal(v.conflictosAsistencia,1)});
const alumno={nombre:'Melissa Angelina',apellido:'Barbeito',email:'verified@example.test'};
test('Busca el PDF individual por nombre corto lugar y sector',()=>assert.equal(selectAgreement([{id:'file',name:'melissabarbeito-ulp-helpdesk.pdf',mimeType:'application/pdf'}],alumno,practice()).id,'file'));
test('No elige un acuerdo de otro lugar',()=>assert.throws(()=>selectAgreement([{name:'melissabarbeito-unsl-helpdesk.pdf',mimeType:'application/pdf'}],alumno,practice()),/Falta/));
test('PDFs duplicados bloquean envío',()=>assert.throws(()=>selectAgreement([1,2].map(id=>({id,name:'melissabarbeito-ulp-helpdesk.pdf',mimeType:'application/pdf'})),alumno,practice()),/varios/));
test('Acuerdo explícito resuelve apellidos compuestos',()=>assert.equal(selectAgreement([{name:'archivo-unico.pdf',id:'x',mimeType:'application/pdf'}],alumno,practice({acuerdoNombre:'archivo-unico.pdf'})).id,'x'));
test('Nombres Word no se toman como PDF',()=>assert.throws(()=>selectAgreement([{name:'melissabarbeito-ulp-helpdesk.pdf',mimeType:'application/msword'}],alumno,practice()),/Falta/));
test('No envía avisos de prácticas pasadas ni canceladas ni ya avisadas',()=>assert.equal(notificationCandidates([practice(),practice({fecha:'2026-10-01',estado:'cancelada'}),practice({fecha:'2026-10-01',avisoAutomaticoEnviado:true})],{diasAviso:3},now).length,0));
test('Incluye avisos dentro de tres días sin cerrar el navegador',()=>assert.equal(notificationCandidates([practice({fecha:'2026-10-01',fechaFin:'2026-10-02'})],{diasAviso:3},now).length,1));
test('Identidad de importación independiente de mayúsculas',()=>assert.equal(practiceId(practice()),practiceId(practice({lugar:'ulp'}))));
test('El formulario rechaza asistencia futura',()=>assert.throws(()=>validateAttendance(record('2026-09-30'),practice({fechaFin:'2026-10-02'}),now),/todavía/));

function memory(initial=[]){
 const store=new Map(initial.map(r=>['asistencias/'+r.id,{...r}]));let queue=Promise.resolve();
 const doc=(_,collection,id)=>({path:collection+'/'+id,id});
 const snap=ref=>({id:ref.id,ref,exists:()=>store.has(ref.path),data:()=>structuredClone(store.get(ref.path))});
 const runTransaction=(_,callback)=>{const call=queue.then(()=>callback({get:async ref=>snap(ref),set:(ref,data)=>store.set(ref.path,structuredClone(data)),update:(ref,data)=>store.set(ref.path,{...store.get(ref.path),...structuredClone(data)})}));queue=call.catch(()=>{});return call;};
 return {store,api:{doc,runTransaction},rows:()=>[...store.entries()].map(([path,data])=>({...data,id:path.split('/')[1]}))};
}
test('Dos sincronizaciones concurrentes crean una jornada por fecha',async()=>{const db=memory(),p=practice();await Promise.all([1,2].map(()=>synchronizeAttendance({db:{},api:db.api,practices:[p],records:[],now})));assert.equal(db.store.size,5)});
test('Una segunda sincronización preserva ausencia y jornada retirada',async()=>{const db=memory([record('2026-09-21','ausente_justificado',{origen:'manual'}),record('2026-09-22','suprimido',{suprimido:true,origen:'manual'})]);await synchronizeAttendance({db:{},api:db.api,practices:[practice()],records:db.rows(),now});assert.equal(db.store.get('asistencias/'+attendanceId('p1','2026-09-21')).estado,'ausente_justificado');assert.equal(db.store.get('asistencias/'+attendanceId('p1','2026-09-22')).suprimido,true)});
test('Legacy manual se vincula sin generar presente adicional',async()=>{const r=record('2026-09-21','ausente_justificado',{id:'old',practicaId:undefined,lugar:'ULP',tipo:'externa',origen:'manual'}),db=memory([r]);await synchronizeAttendance({db:{},api:db.api,practices:[practice()],records:db.rows(),now});assert.equal(db.store.get('asistencias/old').duplicadaEn,attendanceId('p1',r.fecha));assert.equal(db.store.get('asistencias/'+attendanceId('p1',r.fecha)).estado,'ausente_justificado')});
test('Modificar rango invalida una jornada fuera de cronograma',async()=>{const db=memory([record('2026-09-21')]),p=practice({fecha:'2026-09-22'});await synchronizeAttendance({db:{},api:db.api,practices:[p],records:db.rows(),now});assert.equal(db.store.get('asistencias/'+attendanceId('p1','2026-09-21')).fueraCronograma,true)});
test('No crea la jornada de hoy antes de salir',async()=>{const db=memory(),p=practice({fecha:'2026-09-29',fechaFin:'2026-09-29'});await synchronizeAttendance({db:{},api:db.api,practices:[p],records:[],now:{...now,time:'09:00'}});assert.equal(db.store.size,0)});

test('Historial ya sincronizado no abre ninguna transacción adicional',async()=>{const db=memory(),p=practice();await synchronizeAttendance({db:{},api:db.api,practices:[p],records:[],now});let calls=0;const original=db.api.runTransaction;db.api.runTransaction=(...args)=>{calls++;return original(...args);};await synchronizeAttendance({db:{},api:db.api,practices:[p],records:db.rows(),now});assert.equal(calls,0);});
test('Cambiar horario actualiza registros automáticos sin alterar correcciones manuales',async()=>{const db=memory(),p=practice();await synchronizeAttendance({db:{},api:db.api,practices:[p],records:[],now});const key='asistencias/'+attendanceId(p.id,'2026-09-21');db.store.set(key,{...db.store.get(key),origen:'manual',estado:'ausente_justificado',presente:false,editado:'2026-09-22'});await synchronizeAttendance({db:{},api:db.api,practices:[{...p,horaInicio:'09:00'}],records:db.rows(),now});assert.equal(db.store.get(key).estado,'ausente_justificado');assert.equal(db.store.get('asistencias/'+attendanceId(p.id,'2026-09-22')).horaEntrada,'09:00');});

test('Sincronización acota creación y continúa pendientes sin duplicar',async()=>{const db=memory(),p=practice();let pending=0;await synchronizeAttendance({db:{},api:db.api,practices:[p],records:[],now,maxOperations:2,onPending:()=>pending++});assert.equal(db.store.size,2);assert.equal(pending,1);await synchronizeAttendance({db:{},api:db.api,practices:[p],records:db.rows(),now,maxOperations:2});assert.equal(db.store.size,4);});
