export const PAGE_SIZE=20;
export function searchText(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');}
export function searchableFields(collection,data){
 const out={};
 if(collection==='alumnos')for(const field of ['apellido','nombre','legajo','telefono','sector','curso'])if(Object.hasOwn(data,field))out['busqueda_'+field]=searchText(data[field]);
 if(collection==='usuarios')for(const field of ['nombre','email'])if(Object.hasOwn(data,field))out['busqueda_'+field]=searchText(data[field]);
 if(collection==='informes'){if(Object.hasOwn(data,'titulo'))out.busqueda_titulo=searchText(data.titulo);if(data.lugar!==undefined)out.lugar=data.lugar;}
 if(collection==='practicas'&&Object.hasOwn(data,'fechaFin'))out.fechaFin=data.fechaFin||data.fecha||'';
 return out;
}
export function pageSpec(collection,{equal={},from='',to='',prefix='',searchField='',orderField='',direction='desc'}={}){
 const filters=Object.entries(equal).filter(([,v])=>v!==''&&v!==undefined&&v!==null).map(([field,value])=>[field,'==',value]);
 const base=orderField||(collection==='alumnos'||collection==='usuarios'?'__name__':collection==='informes'?'fechaPresentacion':'fecha');
 let order=[[base,direction]];
 if(from){filters.push([collection==='practicas'?'fechaFin':base,'>=',from]);if(collection==='practicas')order=[['fechaFin','desc'],['fecha','desc']];}
 if(to)filters.push([base,'<=',to]);
 if(prefix&&searchField){const value=searchText(prefix);filters.push([searchField,'>=',value],[searchField,'<=',value+'\uf8ff']);order=[[searchField,'asc']];}
 return {collection,filters,order};
}
export function createPager(fetchPage,{now=()=>Date.now(),ttl=60000,maxPages=10}={}){
 let key='',pages=[],index=0,epoch=0,busy=null;
 function reset(){epoch++;key='';pages=[];index=0;busy=null;}
 async function load(spec,move=0){
  const nextKey=JSON.stringify(spec);
  if(nextKey!==key){reset();key=nextKey;move=0;}
  const target=move<0?Math.max(0,index-1):move>0?index+1:0;
  const currentEpoch=epoch;
  if(busy?.target===target&&busy.epoch===epoch)return busy.promise;
  const job=(async()=>{
   let page=pages[target];
   if(!page||page.expires<=now()){
    // Nunca omitir documentos con offsets; guardar el cursor anterior.
    const cursor=target?pages[target-1]?.last:null;
    if(target&&!cursor)throw new Error('Volvé a la primera página para renovar la consulta.');
    const docs=await fetchPage(spec,cursor,PAGE_SIZE);
    if(currentEpoch!==epoch)return null;
    page={docs,last:docs.at(-1),more:docs.length===PAGE_SIZE,expires:now()+ttl};pages[target]=page;if(!docs.length&&target&&pages[target-1])pages[target-1].more=false;
    for(let n=0;n<pages.length-maxPages;n++)if(n!==target-1&&pages[n])pages[n]={last:pages[n].last,expires:0};
   }
   if(currentEpoch!==epoch)return null;
   index=target;return {...page,number:target+1,previous:target>0};
  })();
  busy={target,epoch,promise:job};try{return await job;}finally{if(busy?.promise===job)busy=null;}
 }
 return {load,reset};
}
