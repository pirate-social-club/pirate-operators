/** Actual D1 storage with one injected process-death boundary. Nothing is seeded,
 * acknowledged, reconciled or marked successful by this wrapper. */
export function journalFault(database:D1Database,pattern:RegExp|((sql:string,values:unknown[])=>boolean),where:'before'|'after'='after') {
  let fired=false;
  const originals=new WeakMap<object,D1PreparedStatement>(),queries=new WeakMap<object,string>(),bindings=new WeakMap<object,unknown[]>();
  const trip=(sql:string,values:unknown[]=[])=>{if(!fired&&(typeof pattern==='function'?pattern(sql,values):pattern.test(sql))){fired=true;throw Error('simulated process death at journal boundary');}};
  const statement=(actual:D1PreparedStatement,sql:string,values:unknown[]=[]):D1PreparedStatement=>{
    const proxy=new Proxy(actual,{get(target,key){
      if(key==='bind')return (...values:unknown[])=>statement(target.bind(...values),sql,values);
      if(key==='run'||key==='first'||key==='all'||key==='raw')return async(...args:unknown[])=>{
        if(where==='before')trip(sql,values);const method:unknown=Reflect.get(target,key);
        if(typeof method!=='function')throw Error('invalid D1 fixture method');
        const result:unknown=await Reflect.apply(method,target,args);if(where==='after')trip(sql,values);return result;
      };
      const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});originals.set(proxy,actual);queries.set(proxy,sql);bindings.set(proxy,values);return proxy;
  };
  const wrap=<T extends D1Database|D1DatabaseSession>(actual:T):T=>new Proxy(actual,{get(target,key){
    if(key==='withSession'&&'withSession' in target)return (...args:Parameters<D1Database['withSession']>)=>wrap(target.withSession(...args));
    if(key==='prepare')return(sql:string)=>statement(target.prepare(sql),sql);
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      const sql=statements.map(s=>queries.get(s)??'').join('\n'),values=statements.flatMap(s=>bindings.get(s)??[]);if(where==='before')trip(sql,values);
      const result=await target.batch(statements.map(s=>originals.get(s)??s));if(where==='after')trip(sql,values);return result;
    };
    const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {database:wrap(database),fired:()=>fired};
}
