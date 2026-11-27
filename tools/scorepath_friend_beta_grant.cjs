// Local-only operator command: grants free beta premium features to exactly one existing member.
// NO PG transaction, card details, or payment record is created.
'use strict';
const path=require('node:path');
const dotenv=require('dotenv');
const {Client}=require('pg');
dotenv.config({path:path.join(process.cwd(),'.env'),quiet:true});
function error(msg){throw Error(msg);}
async function main(){
 const [emailRaw,arg] = process.argv.slice(2);
 if (!emailRaw || !arg || process.argv.length>4) {
  console.log('사용법: node tools/scorepath_friend_beta_grant.cjs 친구이메일@example.com 7');
  console.log('권한 취소: node tools/scorepath_friend_beta_grant.cjs 친구이메일@example.com --revoke');
  process.exitCode=1;return;
 }
 const email=emailRaw.trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))error('이메일 형식이 아닙니다.');
 const revoke=arg==='--revoke';
 const days=Number(arg);
 if(!revoke && (!Number.isInteger(days)||days<1||days>14))error('베타 기간은 1~14일로 입력해야 합니다.');
 if(!process.env.DATABASE_URL || !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL))error('프로젝트 .env에 Neon DATABASE_URL을 설정해야 합니다.');
 if(String(process.env.SCOREPATH_STORAGE_MODE||'').toLowerCase()!=='neon')error('SCOREPATH_STORAGE_MODE=neon 이어야 합니다.');
 const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:15000});
 await client.connect();
 try {
  await client.query('BEGIN');
  const member=await client.query('SELECT id,profile FROM scorepath_neon_users WHERE email_norm=$1 FOR UPDATE',[email]);
  if(member.rowCount!==1)error('친구 계정을 찾지 못했습니다. 친구가 먼저 실제 Render 사이트에서 가입했는지 확인하세요.');
  const {id,profile}=member.rows[0];
  const result=await client.query("SELECT document FROM scorepath_neon_documents WHERE document_key='commerce' FOR UPDATE");
  if(result.rowCount!==1)error('Neon 결제 원장이 없습니다.');
  const ledger=result.rows[0].document;
  if(!ledger||typeof ledger!=='object'||!ledger.users||!ledger.payments||!Array.isArray(ledger.refundRequests))error('결제 원장 구조 오류');
  const paid=ledger.users[id];
  const hasRealPaid=paid?.provider==='portone' && paid.verified === true && !paid.refunded && Date.parse(paid.periodEnd)>Date.now();
  if(hasRealPaid)error('이 계정에 유효한 실결제가 있습니다. 베타 권한으로 변경하지 않습니다.');
  ledger.betaGrants ||= {};
  if(revoke){
   if(!ledger.betaGrants[id])error('이 계정에는 취소할 베타 권한이 없습니다.');
   delete ledger.betaGrants[id];
   profile.plan='free';
  }else{
   const activeOther=Object.entries(ledger.betaGrants).filter(([other,grant])=>other!==id && grant?.kind==='friend-beta' && grant.enabled===true && Date.parse(grant.expiresAt)>Date.now());
   if(activeOther.length)error('현재 다른 1명에게 베타 권한이 있습니다. 먼저 기간 만료 또는 취소 후 진행하세요.');
   ledger.betaGrants[id]={kind:'friend-beta',enabled:true,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+days*86400000).toISOString()};
   profile.plan='premium9900';
  }
  await client.query("UPDATE scorepath_neon_documents SET document=$1::jsonb,version=version+1,updated_at=NOW() WHERE document_key='commerce'",[JSON.stringify(ledger)]);
  await client.query('UPDATE scorepath_neon_users SET profile=$1::jsonb,version=version+1,updated_at=NOW() WHERE id=$2',[JSON.stringify(profile),id]);
  await client.query('COMMIT');
  console.log(revoke?'✅ 무료 베타 권한 해제 완료.':'✅ 친구 1명에게 무료 베타 유료기능 권한 지급 완료.');
  if(!revoke)console.log('✅ 만료 시각:',ledger.betaGrants[id].expiresAt,'(자동 만료)');
  console.log('✅ 카드 결제·9,900원 청구·자동갱신: 없음');
  console.log('➡ 친구에게 새로고침 또는 다시 로그인하도록 안내하세요.');
 } catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;} finally{await client.end().catch(()=>{});}
}
main().catch(e=>{console.error('❌',e.message);process.exitCode=1;});
