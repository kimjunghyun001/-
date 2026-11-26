import {Worker} from 'node:worker_threads';
import crypto from 'node:crypto';
const SYMBOL=Symbol.for('scorepath.neon.snapshot.v1');
const LEDGER_SYMBOL=Symbol.for('scorepath.neon.ledger.version.v1');
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
export function createNeonSyncBridge(databaseUrl){
 if(!/^postgres(?:ql)?:\/\//.test(databaseUrl||''))throw Error('Neon 모드에는 DATABASE_URL이 필요합니다.');
 const worker=new Worker(new URL('./worker.cjs',import.meta.url),{workerData:{databaseUrl}});
 const signalBuffer=new SharedArrayBuffer(8),resultBuffer=new SharedArrayBuffer(16*1024*1024);
 const signal=new Int32Array(signalBuffer);
 let exited=false; worker.on('error',e=>{exited=true;console.error('[ScorePath Neon worker]',e.message);});worker.on('exit',code=>{exited=true;console.error('[ScorePath Neon worker exited]',code);});
 function request(action,args={}){
  if(exited)throw Error('Neon 데이터베이스 작업 프로세스가 정지했습니다.');
  Atomics.store(signal,0,0);Atomics.store(signal,1,0);
  worker.postMessage({action,args,signalBuffer,resultBuffer});
  const wait=Atomics.wait(signal,0,0,45000);
  if(wait==='timed-out'){
    // The remote write result may be uncertain. Prevent further processing in this process.
    console.error('[ScorePath Neon] DB 응답 시간 초과. 데이터 일관성 보호를 위해 서버 종료');
    process.exit(1);
  }
  const n=Atomics.load(signal,1);
  if(!n||n>16*1024*1024)throw Error('Neon 응답 손상');
  const body=JSON.parse(Buffer.from(new Uint8Array(resultBuffer,0,n)).toString('utf8'));
  if(!body.ok)throw Error(body.error||'Neon 요청 실패');
  return body.value;
 }
 function readDb(scope=null){
  const rows=request('readUsers',{scope:scope||{}}).rows;
  const db={users:rows.map(r=>r.profile)};
  const baseline=new Map(rows.map(r=>[r.id,{version:Number(r.version),digest:hash(r.profile)}]));
  Object.defineProperty(db,SYMBOL,{value:{baseline,scope:scope||null},enumerable:false});
  return db;
 }
 function writeDb(db){
  if(!db||!Array.isArray(db.users)||!db[SYMBOL])throw Error('Neon에서 읽어온 데이터만 수정할 수 있습니다.');
  const meta=db[SYMBOL],seen=new Set(),ops=[];
  for(const u of db.users){
   if(!u||typeof u.id!=='string'||seen.has(u.id))throw Error('회원 ID 중복 또는 구조 오류');
   seen.add(u.id);const prev=meta.baseline.get(u.id),digest=hash(u);
   if(!prev)ops.push({type:'add',id:u.id,profile:u});
   else if(prev.digest!==digest)ops.push({type:'update',id:u.id,version:prev.version,profile:u});
  }
  for(const [id,prev] of meta.baseline){
   if(!seen.has(id))ops.push({type:'delete',id,version:prev.version});
  }
  if(!ops.length)return;
  const {updated}=request('writeUsers',{ops});
  for(const op of ops){
   if(op.type==='delete')meta.baseline.delete(op.id);
   else meta.baseline.set(op.id,{version:updated[op.id],digest:hash(op.profile)});
  }
 }
 function readLedger(){
  const data=request('readLedger');
  const doc=data.document;
  Object.defineProperty(doc,LEDGER_SYMBOL,{value:data.version,writable:true,enumerable:false});
  return doc;
 }
 function writeLedger(doc){
  if(!doc||!Number.isSafeInteger(doc[LEDGER_SYMBOL]))throw Error('결제 원장을 Neon에서 다시 읽어야 합니다.');
  const {version}=request('writeLedger',{document:doc,version:doc[LEDGER_SYMBOL]});
  doc[LEDGER_SYMBOL]=version;
 }
 return {
  ping:()=>request('ping'),readDb,writeDb,readLedger,writeLedger,
  reserveBudget:(provider,limits)=>request('reserveBudget',{provider,limits}),
  appendUsage:item=>request('appendUsage',{item}),
  appendDeletionRetry:item=>request('appendDeletionRetry',{item})
 };
}
