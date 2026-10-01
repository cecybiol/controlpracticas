// REST con el OAuth de la cuenta Google que autoriza el script. Sin claves privadas.
function CPFirestore(projectId) {
 const name='projects/'+projectId+'/databases/(default)/documents';
 const base='https://firestore.googleapis.com/v1/'+name;
 function request(url,method,data){
  const options={method:method||'get',muteHttpExceptions:true,headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()}};
  if(data!==undefined){options.contentType='application/json';options.payload=JSON.stringify(data);}
  const response=UrlFetchApp.fetch(url,options),status=response.getResponseCode();
  const result=response.getContentText()?JSON.parse(response.getContentText()):{};
  if(status===404)return null;
  if(status<200||status>=300){const err=new Error('Firestore HTTP '+status+': '+(result.error&&result.error.message||'Error'));err.status=status;throw err;}
  return result;
 }
 function encode(v){
  if(v===null)return {nullValue:null};
  if(typeof v==='boolean')return {booleanValue:v};
  if(typeof v==='number')return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
  if(typeof v==='string')return {stringValue:v};
  if(Array.isArray(v))return {arrayValue:{values:v.map(encode)}};
  const fields={};Object.keys(v).forEach(k=>{if(v[k]!==undefined)fields[k]=encode(v[k]);});return {mapValue:{fields}};
 }
 function decode(v){
  if('nullValue'in v)return null;
  if('booleanValue'in v)return v.booleanValue;
  if('integerValue'in v)return Number(v.integerValue);
  if('doubleValue'in v)return v.doubleValue;
  if('stringValue'in v)return v.stringValue;
  if('timestampValue'in v)return v.timestampValue;
  if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode);
  const data={};Object.keys(v.mapValue&&v.mapValue.fields||{}).forEach(k=>data[k]=decode(v.mapValue.fields[k]));return data;
 }
 function row(doc){if(!doc)return null;return {id:doc.name.split('/').pop(),path:doc.name.slice(name.length+1),updateTime:doc.updateTime,data:decode({mapValue:{fields:doc.fields||{}}})};}
 function url(path){return base+'/'+path.split('/').map(encodeURIComponent).join('/');}
 function get(path,transaction){return row(request(url(path)+(transaction?'?transaction='+encodeURIComponent(transaction):'')));}
 function list(collection,where,limit){
  const structuredQuery={from:[{collectionId:collection}]};
  if(where){const conditions=Array.isArray(where[0])?where:[where],filters=conditions.map(w=>({fieldFilter:{field:{fieldPath:w[0]},op:w[1],value:encode(w[2])}}));structuredQuery.where=filters.length===1?filters[0]:{compositeFilter:{op:'AND',filters}};if(conditions.length>1){const ranges=[...new Set(conditions.filter(w=>w[1]!=='EQUAL').map(w=>w[0]))];if(ranges.length)structuredQuery.orderBy=ranges.map(f=>({field:{fieldPath:f},direction:'ASCENDING'}));}}
  if(limit)structuredQuery.limit=limit;
  return (request(base+':runQuery','post',{structuredQuery})||[]).filter(x=>x.document).map(x=>row(x.document));
 }
 function write(path,data,precondition,merge){
  const w={update:{name:name+'/'+path,fields:encode(data).mapValue.fields}};
  if(merge)w.updateMask={fieldPaths:Object.keys(data)};
  if(precondition)w.currentDocument=precondition;return w;
 }
 function commit(writes,transaction){return request(base+':commit','post',Object.assign({writes},transaction?{transaction}:{}));}
 function set(path,data,merge){return commit([write(path,data,null,merge)]);}
 function transaction(fn){
  for(let attempt=0;attempt<3;attempt++){
   const token=request(base+':beginTransaction','post',{}).transaction,writes=[];
   try{
    const result=fn({get:path=>get(path,token),set:(path,data)=>writes.push(write(path,data)),update:(path,data)=>writes.push(write(path,data,null,true))});
    if(writes.length)commit(writes,token);else request(base+':rollback','post',{transaction:token});
    return result;
   }catch(err){try{request(base+':rollback','post',{transaction:token});}catch(_){}if(err.status!==409||attempt===2)throw err;}
  }
 }
 return {get,list,set,transaction,write,commit,name};
}
