// This module deliberately never opens RPHubDB or reads RP-Hub settings.
(function(scope){
 const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('HaishenPushTestV3',1);r.onupgradeneeded=()=>{r.result.createObjectStore('kv');r.result.createObjectStore('notices',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 async function tx(store,mode,action){const db=await open();try{return await new Promise((resolve,reject)=>{const t=db.transaction(store,mode);const r=action(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onerror=t.onabort=()=>reject(t.error||new Error('测试存储未完成'));});}finally{db.close();}}
 scope.HaishenPushStore=Object.freeze({get:k=>tx('kv','readonly',s=>s.get(k)),set:(k,v)=>tx('kv','readwrite',s=>s.put(v,k)),forgetDevice:()=>tx('kv','readwrite',s=>s.delete('device')),saveNotice:n=>tx('notices','readwrite',s=>s.put(n)),notices:()=>tx('notices','readonly',s=>s.getAll())});
})(typeof self==='undefined'?globalThis:self);
