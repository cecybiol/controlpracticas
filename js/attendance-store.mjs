import {clock, datesFor, finished, attendanceId, attendanceMatches, chooseAttendance, manualHours, attendanceState} from './domain.mjs';

export async function synchronizeAttendance({db,api,practices,records,now=clock(),maxOperations=30,onPending=()=>{}}) {
  const {doc,runTransaction}=api;
  let created=0,operations=0,pending=false;
  for(const p of practices){
    if(p.archivada||p.estado==='cancelada'||manualHours(p))continue;
    const dates=datesFor(p);
    for(const date of dates){
      if(!finished(date,p,now))continue;
      const id=attendanceId(p.id,date),ref=doc(db,'asistencias',id);
      const legacy=records.filter(r=>!r.duplicadaEn&&r.id!==id&&r.fecha===date&&attendanceMatches(r,p,practices));
      const ambiguous=records.some(r=>!r.practicaId&&!r.duplicadaEn&&r.fecha===date&&r.alumnoId===p.alumnoId&&r.lugar===p.lugar&&!attendanceMatches(r,p,practices));
      if(ambiguous&&!legacy.length)continue;
      // La consulta inicial ya contiene estas jornadas: no releer registros estables.
      const known=records.find(r=>r.id===id);
      if(known&&!known.duplicadaEn&&!known.fueraCronograma&&!legacy.length&&
         known.practicaId===p.id&&known.alumnoId===p.alumnoId&&known.lugar===(p.lugar||'')&&known.tipo===(p.tipo||'interna')&&
         (known.origen!=='automatico'||known.editado||known.confirmado||known.suprimido||
          (known.horaEntrada===(p.horaInicio||'')&&known.horaSalida===(p.horaFin||''))))continue;
      if(operations>=maxOperations){pending=true;continue;}
      operations++;
      await runTransaction(db,async tx=>{
        const current=await tx.get(ref);
        const snapshots=[];
        for(const row of legacy)snapshots.push(await tx.get(doc(db,'asistencias',row.id)));
        const existing=[...(current.exists()?[{id:current.id,...current.data()}]:[]),...snapshots.filter(s=>s.exists()&&!s.data().duplicadaEn).map(s=>({id:s.id,...s.data()}))];
        const {record,conflict}=chooseAttendance(existing);
        let data;
        if(!existing.length){
          data={estado:'presente',presente:true,horaEntrada:p.horaInicio||'',horaSalida:p.horaFin||'',origen:'automatico',observaciones:'Generado al finalizar la jornada del cronograma',creado:new Date().toISOString()};
        }else if(conflict){
          data={estado:'pendiente',presente:false,origen:'revision',conflicto:true,observaciones:'Hay registros históricos contradictorios. Revisar antes de acreditar horas.'};
        }else{
          data={...record};delete data.id;
          if(data.origen==='automatico'&&!data.editado&&!data.confirmado&&!data.suprimido){data.horaEntrada=p.horaInicio||'';data.horaSalida=p.horaFin||'';}
        }
        Object.assign(data,{practicaId:p.id,alumnoId:p.alumnoId,fecha:date,lugar:p.lugar||'',tipo:p.tipo||'interna',fueraCronograma:false});
        // Guardar con identidad estable. Las copias originales quedan conservadas y excluidas.
        if(!current.exists()||JSON.stringify(current.data())!==JSON.stringify(data))tx.set(ref,data);
        for(const snap of snapshots)if(snap.exists()&&!snap.data().duplicadaEn)tx.update(snap.ref,{duplicadaEn:id});
      });
      if(!records.some(r=>r.id===id))created++;
    }
  }
  // Invalidar cronogramas retirados sin borrar las correcciones históricas.
  const byId=new Map(practices.map(p=>[p.id,p]));
  for(const r of records){
    if(!r.practicaId||r.duplicadaEn)continue;
    const p=byId.get(r.practicaId),invalid=!p||p.archivada||p.estado==='cancelada'||!datesFor(p).includes(r.fecha)||r.alumnoId!==p.alumnoId;
    if(invalid && !r.fueraCronograma){
      if(operations>=maxOperations){pending=true;continue;}
      operations++;
      const ref=doc(db,'asistencias',r.id);
      await runTransaction(db,async tx=>{const s=await tx.get(ref);if(s.exists())tx.update(ref,{fueraCronograma:true});});
    }
  }
  if(pending)onPending();
  return created;
}

export function validateAttendance(data,p,now=clock()){
  if(!p||p.archivada||p.estado==='cancelada')throw new Error('Elegí una práctica activa.');
  if(!datesFor(p).includes(data.fecha))throw new Error('La fecha no es un día de concurrencia de esta práctica.');
  if(!finished(data.fecha,p,now))throw new Error('La jornada todavía no terminó. No se puede acreditar asistencia futura.');
  if(attendanceState(data)==='tardanza'&&(!data.horaEntrada||!data.horaSalida))throw new Error('La tardanza requiere entrada y salida reales.');
  if(data.horaEntrada&&data.horaSalida&&data.horaSalida<=data.horaEntrada)throw new Error('La salida debe ser posterior a la entrada.');
}
