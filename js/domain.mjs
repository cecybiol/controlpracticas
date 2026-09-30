// Reglas compartidas por el navegador, las pruebas y el trabajador programado.
export const TIME_ZONE = 'America/Argentina/San_Luis';
export const round = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };
export const normalize = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const compact = v => normalize(v).replace(/[^a-z0-9]/g, '');
export function clock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}
export function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const dt = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0,10) === date;
}
export function addDays(date, count) {
  if (!validDate(date)) return '';
  const dt = new Date(`${date}T12:00:00Z`); dt.setUTCDate(dt.getUTCDate()+count); return dt.toISOString().slice(0,10);
}
export function daysFor(p) {
  if (Array.isArray(p.diasSemana) && p.diasSemana.length) return [...new Set(p.diasSemana.map(Number))].filter(n=>Number.isInteger(n)&&n>=0&&n<=6);
  if (p.fecha === (p.fechaFin || p.fecha) && validDate(p.fecha)) return [new Date(`${p.fecha}T12:00:00Z`).getUTCDay()];
  const count = Number(p.diasPorSemana ?? 5);
  // Compatibilidad explícita con cronogramas antiguos de lunes a viernes.
  if (count === 5) return [1,2,3,4,5];
  if (count === 7) return [0,1,2,3,4,5,6];
  return []; // No inventar qué dos o tres días semanales corresponden.
}
export function datesFor(p) {
  const end=p.fechaFin || p.fecha, days=new Set(daysFor(p));
  if (!validDate(p.fecha)||!validDate(end)||end<p.fecha||!days.size) return [];
  if ((new Date(`${end}T12:00:00Z`)-new Date(`${p.fecha}T12:00:00Z`))/86400000 > 3660) throw new Error('El período no puede superar diez años.');
  const dates=[];
  for(let date=p.fecha;date<=end;date=addDays(date,1)) if(days.has(new Date(`${date}T12:00:00Z`).getUTCDay())) dates.push(date);
  return dates;
}
export function duration(start, end) {
  if(!/^\d{2}:\d{2}$/.test(start||'')||!/^\d{2}:\d{2}$/.test(end||'')) return null;
  const parse=t=>{const [h,m]=t.split(':').map(Number);return h<24&&m<60?h*60+m:NaN;};
  const a=parse(start),b=parse(end); return Number.isFinite(a)&&Number.isFinite(b)&&b>a ? (b-a)/60 : null;
}
export function dayHours(p) {
  if(p.horasPorDia !== undefined && p.horasPorDia !== '') return num(p.horasPorDia);
  const hours=duration(p.horaInicio,p.horaFin);
  if(hours!==null) return hours;
  const dates=datesFor(p);return dates.length?num(p.horasTotales)/dates.length:0;
}
export function finished(date,p,now=clock()) {
  return date < now.date || (date===now.date && !!p.horaFin && now.time>=p.horaFin);
}
export const attendanceState = r => r.estado || (r.presente === true ? 'presente' : r.presente === false ? 'ausente_injustificado' : 'pendiente');
export const manualHours = p => p.modoHoras === 'manual' || (!p.modoHoras && (p.estado === 'realizada' || (!p.estado && p.realizada === true)));
export function calendarState(p, now=clock()) {
  if(p.archivada || p.estado==='cancelada')return 'cancelada';
  if(manualHours(p)) return validDate(p.fecha) && finished(p.fechaFin||p.fecha,p,now) ? 'realizada' : 'pendiente_revision';
  const dates=datesFor(p);
  if(!dates.length)return 'pendiente_revision';
  if(p.fecha>now.date)return 'programada';
  return dates.every(date=>finished(date,p,now))?'realizada':'en_curso';
}
export function attendanceMatches(r,p,practices=[]) {
  if(r.alumnoId!==p.alumnoId)return false;
  if(r.practicaId)return r.practicaId===p.id;
  const candidates=practices.filter(x=>x.alumnoId===r.alumnoId && !x.archivada && normalize(x.lugar)===normalize(r.lugar) && (!r.tipo||normalize(x.tipo)===normalize(r.tipo)) && datesFor(x).includes(r.fecha));
  return candidates.length===1 && candidates[0].id===p.id;
}
export function chooseAttendance(records) {
  if(!records.length)return {record:null,conflict:false};
  // Una corrección docente tiene precedencia sobre una presencia generada.
  const manual=records.filter(r=>r.origen!=='automatico'||r.editado||r.confirmado||r.suprimido);
  const pool=manual.length?manual:records;
  const signatures=new Set(pool.map(r=>JSON.stringify([attendanceState(r),r.suprimido||false,r.horaEntrada||'',r.horaSalida||''])));
  if(signatures.size>1)return {record:null,conflict:true};
  return {record:pool[0],conflict:false};
}
export function attendanceHours(r,p,now=clock()) {
  if(!r||r.suprimido||r.fueraCronograma||!datesFor(p).includes(r.fecha)||!finished(r.fecha,p,now))return 0;
  if(!['presente','tardanza'].includes(attendanceState(r)))return 0;
  const cap=dayHours(p),actual=duration(r.horaEntrada,r.horaSalida);
  if(attendanceState(r)==='tardanza' && actual===null)return 0;
  const scheduledStart=duration(p.horaInicio,p.horaFin)!==null?p.horaInicio:null;
  if(actual!==null && scheduledStart) {
    const start=r.horaEntrada>p.horaInicio?r.horaEntrada:p.horaInicio;
    const end=r.horaSalida<p.horaFin?r.horaSalida:p.horaFin;
    return round(Math.min(cap,duration(start,end)??0));
  }
  return round(actual===null?cap:Math.min(cap,actual));
}
export function calculatePractice(p,records,practices=[p],now=clock(),scope={}) {
  const dates=datesFor(p),state=calendarState(p,now),planned=round(dates.length*dayHours(p));
  if(state==='cancelada')return {...p,estadoCalculado:state,horasRealizadas:0,horasPendientes:0,horasPlanificadas:0,jornadasPendientes:0,conflictosAsistencia:0};
  const inside=dates.filter(date=>(!scope.desde||date>=scope.desde)&&(!scope.hasta||date<=scope.hasta));
  if(manualHours(p)) {
    const incompleteScope=(scope.desde&&scope.desde>p.fecha)||(scope.hasta&&scope.hasta<(p.fechaFin||p.fecha));
    return {...p,estadoCalculado:state,horasRealizadas:state==='realizada'&&!incompleteScope?num(p.horasTotales):0,horasPlanificadas:num(p.horasTotales),horasPendientes:0,jornadasPendientes:0,conflictosAsistencia:0,requiereDesglose:!!incompleteScope};
  }
  let earned=0,missing=0,conflicts=0;
  for(const date of inside){
    const {record,conflict}=chooseAttendance(records.filter(r=>!r.duplicadaEn&&r.fecha===date&&attendanceMatches(r,p,practices)));
    if(conflict){conflicts++;continue;}
    earned+=attendanceHours(record,p,now);
    if(finished(date,p,now)&&(!record||(!record.suprimido&&attendanceState(record)==='pendiente')))missing++;
  }
  const future=inside.filter(date=>!finished(date,p,now)).length*dayHours(p);
  return {...p,estadoCalculado:state,horasRealizadas:round(earned),horasPlanificadas:planned,horasPendientes:round(future),jornadasPendientes:missing,conflictosAsistencia:conflicts,cronogramaEstimado:!p.diasSemana?.length};
}
export const practiceId = p => 'import_'+encodeURIComponent([p.alumnoId,normalize(p.lugar),normalize(p.sector),normalize(p.tipo),p.fecha,p.fechaFin||p.fecha,p.horaInicio||'',p.horaFin||''].join('|'));
export const attendanceId = (id,date) => 'jornada_'+encodeURIComponent(id)+'_'+date;
export function expectedAgreementNames(a,p) {
  if(p.acuerdoNombre)return [normalize(p.acuerdoNombre)];
  const names=new Set([compact(`${a.nombre}${a.apellido}`),compact(`${String(a.nombre||'').split(/\s+/)[0]}${String(a.apellido||'').split(/\s+/)[0]}`)]);
  return [...names].filter(Boolean).map(n=>`${n}-${compact(p.lugar)}-${compact(p.sector)}.pdf`);
}
export function selectAgreement(files,a,p) {
  const expected=expectedAgreementNames(a,p);
  const matches=files.filter(f=>(f.mimeType||f.mime_type)==='application/pdf' && expected.includes(normalize(f.name||f.title)));
  if(matches.length!==1)throw new Error(matches.length?'Hay varios acuerdos PDF coincidentes. Indicá un nombre único.':`Falta el acuerdo PDF ${expected.join(' o ')}.`);
  return matches[0];
}
export const validEmail = v => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(v||'').trim());
export function notificationCandidates(practices,config,now=clock()) {
  const days=Number(config.diasAviso??3);
  if(!Number.isInteger(days)||days<0||days>90)throw new Error('Los días de aviso deben estar entre 0 y 90.');
  const until=addDays(now.date,days);
  return practices.filter(p=>!p.archivada&&p.estado!=='cancelada'&&!manualHours(p)&&p.fecha>=now.date&&p.fecha<=until&&!p.avisoAutomaticoEnviado);
}
export function targets(hours,goals) {
  const earned=[num(hours.interna),num(hours.externa),num(hours.interescolar)],req=[num(goals.interna),num(goals.externa),num(goals.interescolar)];
  const total=req.reduce((a,b)=>a+b,0),covered=req.reduce((s,n,i)=>s+Math.min(n,earned[i]),0);
  return {faltan:round(req.reduce((s,n,i)=>s+Math.max(0,n-earned[i]),0)),pct:total?covered/total*100:0};
}
export function parseDays(value) {
  const aliases={dom:0,domingo:0,lun:1,lunes:1,mar:2,martes:2,mie:3,miercoles:3,jue:4,jueves:4,vie:5,viernes:5,sab:6,sabado:6};
  const tokens=normalize(value).split(/[;,\s]+/).filter(Boolean);
  const days=tokens.map(x=>/^\d$/.test(x)?Number(x):aliases[x]);
  if(!days.length||days.some(x=>!Number.isInteger(x)||x<0||x>6))throw new Error('Indicá días exactos como lun,mar,mie,jue,vie.');
  return [...new Set(days)].sort();
}
