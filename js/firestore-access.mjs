// Caché sólo en memoria, con límite y deduplicación de solicitudes simultáneas.
export function firestoreMessage(err){
 if(String(err?.code||'').split('/').at(-1)==='resource-exhausted')return 'Firestore alcanzó un límite de consumo. Revisá Uso y Cuotas en Firebase; si se agotó la cuota diaria gratuita, hay que esperar su renovación. No se perdió tu cuenta.';
 return err?.message||String(err);
}
export function createFirestoreAccess(api,{ttl=60000,cooldown=60000,now=()=>Date.now(),maxEntries=40}={}){
 let entries=[],generation=0,blockedUntil=0,lastQuota;
 const quota=err=>String(err?.code||'').split('/').at(-1)==='resource-exhausted';
 function failed(err){if(quota(err)){lastQuota=err;blockedUntil=now()+cooldown;}}
 function guard(){if(now()<blockedUntil)throw lastQuota;}
 function clear(){generation++;entries=[];}
 function reset(){clear();blockedUntil=0;lastQuota=undefined;}
 async function read(kind,ref){
  const same=kind==='getDocs'?api.queryEqual:api.refEqual;
  const entry=entries.find(e=>e.kind===kind&&same(e.ref,ref));
  if(entry&&(entry.pending||entry.expires>now()))return entry.promise;
  guard();
  if(entry)entries.splice(entries.indexOf(entry),1);
  const epoch=generation,item={kind,ref,pending:true,expires:0};
  entries.push(item);if(entries.length>maxEntries)entries.shift();
  item.promise=Promise.resolve().then(()=>api[kind](ref)).then(result=>{
   item.pending=false;item.expires=now()+ttl;
   // Las fichas ya presentes en un listado no necesitan otro getDoc.
   if(epoch===generation&&kind==='getDocs'&&(result.docs?.length||0)<=20)for(const snapshot of result.docs||[]){if(!snapshot.ref)continue;entries=entries.filter(e=>!(e.kind==='getDoc'&&api.refEqual(e.ref,snapshot.ref)));entries.push({kind:'getDoc',ref:snapshot.ref,pending:false,expires:item.expires,promise:Promise.resolve(snapshot)});}
   while(entries.length>maxEntries)entries.shift();
   if(epoch!==generation)entries=entries.filter(e=>e!==item);
   return result;
  }).catch(err=>{entries=entries.filter(e=>e!==item);failed(err);throw err;});
  return item.promise;
 }
 function cachedDoc(ref){const entry=entries.find(e=>e.kind==='getDoc'&&api.refEqual(e.ref,ref));return entry&&!entry.pending&&entry.expires>now()?entry.promise:null;}
 return {cachedDoc,getDocs:ref=>read('getDocs',ref),getDoc:ref=>read('getDoc',ref),clear,reset,failed,guard};
}
