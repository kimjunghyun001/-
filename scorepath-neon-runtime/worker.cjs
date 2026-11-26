'use strict';
// Synchronous RPC worker: PostgreSQL operations occur on a separate thread.
// Small single-Render-instance beta bridge for legacy synchronous readDb/writeDb.
const {parentPort,workerData}=require('node:worker_threads');
const {Pool}=require('pg');
const pool=new Pool({connectionString:workerData.databaseUrl,max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:20000,query_timeout:15000,statement_timeout:15000});
const enc=new TextEncoder();
const defaultLedger=()=>({version:1,users:{},payments:{},refundRequests:[]});
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const assertLedger=v=>{if(!isObj(v)||!isObj(v.users)||!isObj(v.payments)||!Array.isArray(v.refundRequests)) throw Error('결제 원장 구조 오류');};
function safeId(x){if(typeof x!=='string'||x.length>200||!x)throw Error('비정상 ID');return x;}
async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const x=await fn(c);await c.query('COMMIT');return x;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
async function handle(action,args){
 switch(action){
  case 'ping': {
   const {rows}=await pool.query("SELECT active FROM scorepath_neon_runtime_meta WHERE id=1");
   if(rows.length!==1||rows[0].active!==true)throw Error('Neon 활성화가 필요합니다. promote.cjs --activate 를 먼저 실행해 주세요.');
   return {ready:true};
  }
  case 'readUsers': {
   const a=args.scope||{};
   let q='SELECT id,profile,version FROM scorepath_neon_users ORDER BY id',p=[];
   if(a.id){q='SELECT id,profile,version FROM scorepath_neon_users WHERE id=$1';p=[safeId(a.id)];}
   else if(a.email){q='SELECT id,profile,version FROM scorepath_neon_users WHERE email_norm=$1';p=[String(a.email).trim().toLowerCase()];}
   const {rows}=await pool.query(q,p);return {rows};
  }
  case 'writeUsers': return transaction(async c=>{
   const ops=args.ops||[];
   if(!Array.isArray(ops)||ops.length>10000)throw Error('사용자 DB 변경 항목이 잘못됐습니다.');
   const updated={};
   for(const op of ops){
    const id=safeId(op.id);
    if(op.type==='add'){
     if(!isObj(op.profile)||op.profile.id!==id)throw Error('추가할 회원 ID 불일치');
     const email=String(op.profile.email||'').trim().toLowerCase();
     if(!email||email.length>254)throw Error('회원 이메일 누락');
     await c.query('INSERT INTO scorepath_neon_users(id,email_norm,profile,version) VALUES($1,$2,$3::jsonb,0)',[id,email,JSON.stringify(op.profile)]);
     updated[id]=0;
    } else if(op.type==='update'){
     if(!isObj(op.profile)||op.profile.id!==id||!Number.isSafeInteger(op.version))throw Error('변경할 회원 구조 오류');
     const email=String(op.profile.email||'').trim().toLowerCase();
     const r=await c.query('UPDATE scorepath_neon_users SET profile=$1::jsonb,email_norm=$2,version=version+1,updated_at=NOW() WHERE id=$3 AND version=$4 RETURNING version',[JSON.stringify(op.profile),email,id,op.version]);
     if(r.rowCount!==1)throw Error('다른 요청에서 사용자 정보가 변경되었습니다. 저장하지 않았습니다. 새로고침 후 다시 시도해 주세요.');
     updated[id]=Number(r.rows[0].version);
    }else if(op.type==='delete'){
     if(!Number.isSafeInteger(op.version))throw Error('삭제 버전 오류');
     const r=await c.query('DELETE FROM scorepath_neon_users WHERE id=$1 AND version=$2',[id,op.version]);
     if(r.rowCount!==1)throw Error('다른 요청에서 사용자 정보가 변경되었습니다. 삭제하지 않았습니다.');
     updated[id]=null;
    }else throw Error('알 수 없는 저장 작업');
   }
   return {updated};
  });
  case 'readLedger': {
   const {rows}=await pool.query("SELECT document,version FROM scorepath_neon_documents WHERE document_key='commerce'");
   if(rows.length!==1)throw Error('영구 결제 원장이 없습니다. 초기화/운영자 확인 필요');
   assertLedger(rows[0].document);
   return {document:rows[0].document,version:Number(rows[0].version)};
  }
  case 'writeLedger':return transaction(async c=>{
   assertLedger(args.document);
   if(!Number.isSafeInteger(args.version))throw Error('결제 원장 버전이 없습니다');
   const r=await c.query("UPDATE scorepath_neon_documents SET document=$1::jsonb,version=version+1,updated_at=NOW() WHERE document_key='commerce' AND version=$2 RETURNING version",[JSON.stringify(args.document),args.version]);
   if(r.rowCount!==1)throw Error('결제 정보가 다른 요청에서 변경되었습니다. 처리를 중단했습니다. 결제 상태를 확인하세요.');
   return {version:Number(r.rows[0].version)};
  });
  case 'reserveBudget':return transaction(async c=>{
   const provider=args.provider;
   if(!['gemini','openai'].includes(provider))throw Error('예산 공급자 오류');
   const n=(k,def)=>{const v=Number(args.limits?.[k]??def);if(!Number.isFinite(v)||v<=0)throw Error('예산 설정 오류 '+k);return Math.round(v*1e6);};
   const daily=n('daily',2),monthly=n('monthly',10),reserve=n('reserve',provider==='gemini'?0.02:0.05);
   const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),month=day.slice(0,7),key='ai-budget-'+month+'.json';
   const empty={month,monthReservedMicroUsd:0,days:{}};
   await c.query('INSERT INTO scorepath_neon_documents(document_key,document,version) VALUES($1,$2::jsonb,0) ON CONFLICT DO NOTHING',[key,JSON.stringify(empty)]);
   const {rows}=await c.query('SELECT document FROM scorepath_neon_documents WHERE document_key=$1 FOR UPDATE',[key]);
   if(rows.length!==1)throw Error('AI 예산 정보를 읽을 수 없음');
   const v=rows[0].document;
   if(!isObj(v)||v.month!==month||!isObj(v.days)||!Number.isSafeInteger(v.monthReservedMicroUsd)||v.monthReservedMicroUsd<0)throw Error('AI 예산 장부 손상. 호출을 중단합니다.');
   const used=v.days[day]||0;
   if(!Number.isSafeInteger(used)||used<0)throw Error('AI 예산 장부 손상');
   if(used+reserve>daily||v.monthReservedMicroUsd+reserve>monthly)throw Error('ScorePath 전체 AI 예산 한도에 도달했습니다.');
   v.days[day]=used+reserve;v.monthReservedMicroUsd+=reserve;
   await c.query('UPDATE scorepath_neon_documents SET document=$1::jsonb,version=version+1,updated_at=NOW() WHERE document_key=$2',[JSON.stringify(v),key]);
   return {todayReservedUsd:v.days[day]/1e6,monthReservedUsd:v.monthReservedMicroUsd/1e6,day,provider};
  });
  case 'appendUsage': {
   if(!isObj(args.item)||!args.item.timestamp)throw Error('AI 사용량 기록 오류');
   await pool.query('INSERT INTO scorepath_neon_usage_events(payload) VALUES($1::jsonb)',[JSON.stringify(args.item)]);return {ok:true};
  }
  case 'appendDeletionRetry': {
   if(!isObj(args.item))throw Error('R2 삭제 재시도 정보 오류');
   await pool.query('INSERT INTO scorepath_neon_deletion_retries(payload) VALUES($1::jsonb)',[JSON.stringify(args.item)]);return {ok:true};
  }
  default:throw Error('허용되지 않은 Neon 작업');
 }
}
parentPort.on('message',async ({action,args,signalBuffer,resultBuffer})=>{
 const flag=new Int32Array(signalBuffer),bytes=new Uint8Array(resultBuffer);
 let body;
 try{body={ok:true,value:await handle(action,args||{})};}
 catch(e){body={ok:false,error:String(e.message||'Neon 오류').slice(0,800)};}
 const encoded=enc.encode(JSON.stringify(body));
 if(encoded.length>bytes.length){const tiny=enc.encode(JSON.stringify({ok:false,error:'DB 응답이 허용된 임시 메모리 크기를 초과했습니다. 데이터를 보호하기 위해 차단했습니다.'}));bytes.set(tiny);Atomics.store(flag,1,tiny.length);}
 else{bytes.set(encoded);Atomics.store(flag,1,encoded.length);}
 Atomics.store(flag,0,1);Atomics.notify(flag,0,1);
});
pool.on('error',e=>console.error('[ScorePath Neon] DB pool:',e.message));
