// ScorePath prelaunch commerce — single-process, file-backed beta implementation.
// NO card details are collected. Real transactions require an adult merchant's PG contract.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PRICE = 9900;
const POLICY_VERSION = '2026-11-26-draft';
const iso = () => new Date().toISOString();
const uid = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '');
const str = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
const nextMonth = (date) => {
  const d = new Date(date); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return d.toISOString();
};
function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress ?? '');
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
}

export function installCommerce(app, { dataDir, requireAuth, readDb, writeDb, bcrypt, r2Client, DeleteObjectCommand }) {
  // All session-authenticated state-changing routes must be same-origin.
  // PortOne webhooks have no browser Origin header and still require server-side PG re-verification.
  if (typeof app.use === 'function') app.use('/api/scorepath-commerce', (req, res, next) => {
    const origin = req.get?.('origin');
    if (origin && ['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      try {
        const target = new URL(origin);
        if (!['http:','https:'].includes(target.protocol) || target.host !== req.get('host'))
          return res.status(403).json({error:'다른 출처에서 보낸 요청은 허용하지 않습니다.'});
      } catch { return res.status(403).json({error:'요청 출처를 확인할 수 없습니다.'}); }
    }
    next();
  });
  const neonStore = app.locals.scorePathNeon || null;
  const ledgerPath = path.join(dataDir, 'scorepath-commerce.json');
  const backupDir = path.join(dataDir, 'backups');
  const activeOps = new Set();
  const pgMode = str(process.env.SCOREPATH_PAYMENT_MODE, 20).toLowerCase();
  const config = {
    storeId: str(process.env.PORTONE_STORE_ID, 140),
    channelKey: str(process.env.PORTONE_CHANNEL_KEY, 140),
    apiSecret: process.env.PORTONE_API_SECRET || '',
    cryptoKey: process.env.SCOREPATH_BILLING_KEY_SECRET || '',
    pgEnv: str(process.env.SCOREPATH_PG_ENV, 10).toLowerCase(),
    approved: process.env.SCOREPATH_POLICIES_APPROVED === 'true',
    liveAllowed: process.env.SCOREPATH_ALLOW_LIVE_CHARGES === 'true',
    supportEmail: str(process.env.SCOREPATH_SUPPORT_EMAIL, 254),
    merchantName: str(process.env.SCOREPATH_BUSINESS_NAME, 80),
  };
  const realConfigured = pgMode === 'portone' && config.storeId && config.channelKey && config.apiSecret &&
    /^[0-9a-fA-F]{64}$/.test(config.cryptoKey) && config.approved && config.merchantName &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail) &&
    ['test', 'live'].includes(config.pgEnv) && (config.pgEnv === 'test' || config.liveAllowed);
  if (process.env.NODE_ENV === 'production' && pgMode === 'demo') {
    throw new Error('운영 환경에서는 데모 결제 모드를 사용할 수 없습니다.');
  }
  if (pgMode === 'portone' && !realConfigured) {
    console.warn('[ScorePath commerce] PG 설정/약관 확정이 부족하여 실결제 기능은 차단됩니다.');
  }
  function demoEnabled(req) {
    return process.env.NODE_ENV !== 'production' && pgMode !== 'portone' &&
      process.env.SCOREPATH_DISABLE_LOCAL_PAYMENT_DEMO !== 'true' && isLoopback(req);
  }
  function provider(req) { return realConfigured ? 'portone' : demoEnabled(req) ? 'demo' : 'disabled'; }
  function emptyLedger() { return { version: 1, users: {}, payments: {}, refundRequests: [] }; }
  function load() {
    if (neonStore) return neonStore.readLedger();
    if (!fs.existsSync(ledgerPath)) {
      if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).some(n => n.startsWith('scorepath-commerce-'))) {
        throw new Error('결제 원장 파일 분실 가능성: 백업이 있으므로 새 원장 생성 중단');
      }
      return emptyLedger();
    }
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!ledger || !ledger.users || !ledger.payments || !Array.isArray(ledger.refundRequests))
      throw new Error('결제 원장 데이터 구조 오류. 수정을 중단했습니다.');
    return ledger;
  }
  function save(ledger) {
    if (neonStore) return neonStore.writeLedger(ledger);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(ledgerPath)) {
      const dailyBackup = path.join(backupDir, 'scorepath-commerce-' + iso().slice(0, 10) + '.json');
      if (!fs.existsSync(dailyBackup)) fs.copyFileSync(ledgerPath, dailyBackup, fs.constants.COPYFILE_EXCL);
    }
    const tmp = ledgerPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, ledgerPath);
  }
  function enc(text) {
    const key = Buffer.from(config.cryptoKey, 'hex');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const crypt = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv.toString('hex'), c.getAuthTag().toString('hex'), crypt.toString('hex')].join('.');
  }
  function dec(text) {
    const [a,b,c] = String(text).split('.');
    const cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.cryptoKey,'hex'), Buffer.from(a,'hex'));
    cipher.setAuthTag(Buffer.from(b,'hex'));
    return Buffer.concat([cipher.update(Buffer.from(c,'hex')), cipher.final()]).toString('utf8');
  }
  async function portone(url, {method='GET', body=null}={}) {
    const response = await fetch('https://api.portone.io' + url, {
      method, headers: {'Authorization':'PortOne ' + config.apiSecret, ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)
    });
    const raw = await response.text(); let data;
    try {data = JSON.parse(raw);} catch {data={};}
    if (!response.ok) throw new Error('PG 요청 실패(' + response.status + '): ' + str(data.message || data.type || '지원 문의', 120));
    return data;
  }
  function paidStatus(data) {
    return data && data.status === 'PAID' && data.amount && Number(data.amount.total) === PRICE &&
      (!data.storeId || data.storeId === config.storeId) && (data.currency === 'KRW' || !data.currency);
  }
  function stateOf(ledger, userId) {return ledger.users[userId] || null;}
  function validPaid(userId) {
    if (process.env.NODE_ENV !== 'production' && pgMode !== 'portone') return true; // local demo only
    try {
      const sub = stateOf(load(), userId);
      return !!(sub && sub.verified === true && sub.provider === 'portone' &&
        !sub.refunded && Date.parse(sub.periodEnd) > Date.now());
    } catch (e) { console.error('[commerce] entitlement check failed:', e.message); return false; }
  }
  function ensurePaidAccess(req, res, next) { // reserved for future postpaid features
    if (req.currentUser.plan === 'premium9900' && !validPaid(req.currentUser.id))
      return res.status(403).json({error:'유효한 결제 내역이 확인되지 않았습니다.'});
    next();
  }
  const msgErr = (res, err, fallback='요청을 처리하지 못했습니다.') => {
    console.error('[ScorePath commerce]', err);
    return res.status(400).json({error: String(err?.message || fallback).slice(0,250)});
  };
  const publicStatus = (ledger, userId, req) => {
    const sub=stateOf(ledger,userId);
    const mode=provider(req);
    return {
      mode, price:PRICE, policyVersion:POLICY_VERSION,
      realPaymentReady: mode === 'portone',
      storeId: mode === 'portone' ? config.storeId : '',
      channelKey: mode === 'portone' ? config.channelKey : '',
      active:!!(sub && sub.verified && !sub.refunded && Date.parse(sub.periodEnd) > Date.now()),
      provider:sub?.provider || 'none',
      autoRenew:!!sub?.autoRenew,
      periodEnd:sub?.periodEnd || null,
      pending:!!sub?.pendingPaymentId,
      supportEmail:config.supportEmail,
      merchantName:config.merchantName,
      refunds:ledger.refundRequests.filter(r=>r.userId===userId).map(r=>({id:r.id,paymentId:r.paymentId,status:r.status,createdAt:r.createdAt,reason:r.reason})),
    };
  };
  function syncPlan(sub, userId) {
    const db=readDb(neonStore ? {id:userId} : null); const user=db.users.find(u=>u.id===userId);
    if (!user) return;
    const premium=!!(sub?.verified && !sub.refunded && Date.parse(sub.periodEnd)>Date.now());
    if (user.plan !== (premium ? 'premium9900' : 'free')) {user.plan = premium?'premium9900':'free'; writeDb(db);}
  }
  // Called from the existing auth middleware: stale test-premium plans must not enter production.
  app.locals.scorePathCommerceHasPaid = validPaid;
  app.get('/api/scorepath-commerce/status', requireAuth, (req,res)=>{
    try {return res.json(publicStatus(load(), req.currentUser.id, req));} catch(e){return msgErr(res,e);}
  });
  app.get('/api/scorepath-commerce/history', requireAuth, (req,res)=>{
    try {
      const ledger=load();
      const payments=Object.values(ledger.payments).filter(p=>p.userId===req.currentUser.id)
        .map(p=>({paymentId:p.paymentId,amount:p.amount,status:p.status,provider:p.provider,createdAt:p.createdAt,paidAt:p.paidAt||null,refundedAt:p.refundedAt||null})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return res.json({payments:payments.slice(0,100)});
    } catch(e){return msgErr(res,e);}
  });
  async function renewSchedule(ledger, userId, sub) {
    if (sub.provider !== 'portone' || !sub.autoRenew || !sub.billingKeyCipher) return;
    const paymentId=uid('sp-renew-');
    const billingKey=dec(sub.billingKeyCipher);
    const p = {paymentId, userId,amount:PRICE,status:'SCHEDULED',provider:'portone',createdAt:iso(),renewal:true};
    ledger.payments[paymentId]=p; save(ledger);
    const response=await portone('/payments/'+encodeURIComponent(paymentId)+'/schedule',{
      method:'POST', body:{payment:{billingKey,orderName:'ScorePath 월간 구독 갱신', customer:{id:userId}, amount:{total:PRICE},currency:'KRW'},timeToPay:sub.periodEnd}
    });
    sub.nextPaymentId=paymentId;
    sub.nextScheduleId=response.schedule?.id || null;
    save(ledger);
  }
  async function verifyAndApply(ledger, paymentId) {
    const existing=ledger.payments[paymentId]; if(!existing) return false;
    if (existing.status==='PAID') return true;
    const result=await portone('/payments/'+encodeURIComponent(paymentId));
    if(!paidStatus(result)) {
      if (['FAILED','CANCELLED'].includes(result.status)) {
        existing.status=result.status;
        const pending=stateOf(ledger,existing.userId);
        if(pending && pending.pendingPaymentId===paymentId){
          pending.pendingPaymentId=null;
          pending.autoRenew=false;
          pending.billingKeyCipher=null;
        }
        save(ledger);
      }
      return false;
    }
    const sub=stateOf(ledger,existing.userId);
    if(!sub || sub.refunded || !sub.autoRenew && existing.renewal) return false;
    if(existing.renewal && sub.nextPaymentId!==paymentId) return false;
    existing.status='PAID'; existing.paidAt=result.paidAt || iso();
    sub.verified=true; sub.periodStart=iso();
    sub.periodEnd=existing.renewal ? nextMonth(sub.periodEnd) : nextMonth(iso());
    sub.pendingPaymentId=null;
    sub.nextPaymentId=null; sub.nextScheduleId=null;
    save(ledger); syncPlan(sub,existing.userId);
    // Missing schedule must not negate a successful payment; display warning in the UI.
    try { await renewSchedule(ledger,existing.userId,sub); }
    catch(e) { console.error('[commerce] Next billing schedule failed, customer should be notified:',e.message); sub.autoRenew=false;save(ledger);}
    return true;
  }
  app.post('/api/scorepath-commerce/subscribe', requireAuth, async(req,res)=>{
    const userId=req.currentUser.id; if(activeOps.has(userId)) return res.status(409).json({error:'다른 결제 요청을 처리 중입니다.'});
    activeOps.add(userId);
    try {
      const mode=provider(req); if(mode==='disabled') return res.status(403).json({error:'PG 계약/설정이 완료되지 않아 결제가 비활성화되어 있습니다.'});
      if (req.body?.agreedPolicyVersion!==POLICY_VERSION || req.body?.confirmedAutoRenew!==true)
        return res.status(400).json({error:'이용약관·정기결제·환불 안내를 확인하고 동의해 주세요.'});
      const ledger=load(); let sub=stateOf(ledger,userId);
      if(sub && sub.verified && !sub.refunded && Date.parse(sub.periodEnd)>Date.now())
        return res.status(409).json({error:'현재 이용 중인 유료 구독이 있습니다.'});
      if(sub?.pendingPaymentId) return res.status(409).json({error:'처리 중인 결제가 있습니다. 결제 내역에서 확인·동기화를 해주세요.'});
      const paymentId=uid('sp-first-');
      const payment={paymentId,userId,amount:PRICE,status:'PENDING',provider:mode,createdAt:iso(),renewal:false};
      ledger.payments[paymentId]=payment;
      sub={verified:false,refunded:false,autoRenew:true,provider:mode,periodStart:null,periodEnd:null,billingKeyCipher:null,pendingPaymentId:paymentId, nextPaymentId:null,nextScheduleId:null};
      ledger.users[userId]=sub;save(ledger);
      if (mode==='demo') {
        // Only a localhost, non-production no-money simulation (explicitly marked in UI).
        payment.status='PAID';payment.paidAt=iso();
        sub.verified=true;sub.periodStart=iso();sub.periodEnd=nextMonth(iso());sub.pendingPaymentId=null;
        save(ledger);syncPlan(sub,userId);
        return res.json({ok:true,mode,paidAmount:0,displayAmount:PRICE,paymentId,note:'모의 결제: 실제 청구 0원'});
      }
      const billingKey=str(req.body?.billingKey,256);
      if(!/^billing-key-[a-zA-Z0-9-]+$/.test(billingKey)) {
        delete ledger.payments[paymentId]; delete ledger.users[userId]; save(ledger);
        return res.status(400).json({error:'PG에서 발급받은 결제수단 정보가 올바르지 않습니다.'});
      }
      sub.billingKeyCipher=enc(billingKey);
      save(ledger);
      await portone('/payments/'+encodeURIComponent(paymentId)+'/billing-key',{method:'POST',body:{billingKey,orderName:'ScorePath 월간 정기결제',customer:{id:userId},amount:{total:PRICE},currency:'KRW'}});
      const confirmed=await verifyAndApply(load(),paymentId);
      if(!confirmed) return res.status(409).json({error:'PG 결제 완료가 아직 확인되지 않았습니다. 결제 동기화로 다시 확인해 주세요.',paymentId});
      return res.json({ok:true,mode,paidAmount:PRICE,displayAmount:PRICE,paymentId});
    } catch(e){return msgErr(res,e);} finally {activeOps.delete(userId);}
  });
  app.post('/api/scorepath-commerce/sync',requireAuth,async(req,res)=>{
    try {const ledger=load(); const sub=stateOf(ledger,req.currentUser.id);
      if(sub?.provider !== 'portone' || !sub.pendingPaymentId) return res.json({ok:true,status:publicStatus(ledger,req.currentUser.id,req)});
      const ok=await verifyAndApply(ledger,sub.pendingPaymentId);
      return res.json({ok,status:publicStatus(load(),req.currentUser.id,req)});
    } catch(e){return msgErr(res,e);}
  });
  async function cancelRenewal(ledger,userId) {
    const sub=stateOf(ledger,userId);
    if(!sub) return {message:'구독 정보가 없습니다.'};
    if(!sub.autoRenew) return {message:'이미 자동 갱신이 중단되어 있습니다.'};
    if(sub.provider==='portone' && sub.nextScheduleId) {
      await portone('/payment-schedules',{method:'DELETE',body:{scheduleIds:[sub.nextScheduleId]}});
    } else if(sub.provider==='portone' && sub.billingKeyCipher) {
      // PortOne supports cancellation of all schedules for a billing key.
      await portone('/payment-schedules',{method:'DELETE',body:{billingKey:dec(sub.billingKeyCipher)}});
    }
    sub.autoRenew=false;sub.cancelledAt=iso();sub.nextScheduleId=null;sub.nextPaymentId=null;save(ledger);
    return {message:'다음 자동결제가 중단되었습니다. 남은 이용기간은 유지됩니다.'};
  }
  app.post('/api/scorepath-commerce/cancel',requireAuth,async(req,res)=>{
    try{const ledger=load();const result=await cancelRenewal(ledger,req.currentUser.id);return res.json({ok:true,...result,status:publicStatus(ledger,req.currentUser.id,req)});}catch(e){return msgErr(res,e);}
  });
  app.post('/api/scorepath-commerce/refund-request',requireAuth,(req,res)=>{
    try{
      const ledger=load(); const paymentId=str(req.body?.paymentId,128), reason=str(req.body?.reason,600);
      const p=ledger.payments[paymentId];
      if(!p || p.userId!==req.currentUser.id || p.status!=='PAID') return res.status(404).json({error:'환불 신청할 결제를 찾지 못했습니다.'});
      if(reason.length<3) return res.status(400).json({error:'환불 사유를 3자 이상 입력해 주세요.'});
      if(ledger.refundRequests.some(r=>r.paymentId===paymentId && ['REQUESTED','PROCESSING'].includes(r.status)))
        return res.status(409).json({error:'이미 환불 처리 중인 결제입니다.'});
      const request={id:uid('rf-'),paymentId,userId:req.currentUser.id,reason,status:'REQUESTED',createdAt:iso()};
      ledger.refundRequests.push(request);save(ledger);
      return res.json({ok:true,id:request.id,message:'환불 신청이 접수되었습니다. 실제 환불은 운영자 확인 후 진행됩니다.'});
    }catch(e){return msgErr(res,e);}
  });
  const adminSecret = process.env.SCOREPATH_ADMIN_SECRET || '';
  function requireAdmin(req,res,next) {
    if(adminSecret.length<32) return res.status(503).json({error:'운영자 인증이 설정되지 않았습니다.'});
    const supplied=req.get('x-scorepath-admin-secret') || '';
    if(supplied.length !== adminSecret.length || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(adminSecret)))
      return res.status(403).json({error:'권한 없음'});
    return next();
  }
  app.get('/api/scorepath-commerce/admin/refund-requests',requireAdmin,(req,res)=>{
    try {return res.json({requests:load().refundRequests});} catch(e){return msgErr(res,e);}
  });
  app.post('/api/scorepath-commerce/admin/refund',requireAdmin,async(req,res)=>{
    try{
      const ledger=load();const rf=ledger.refundRequests.find(r=>r.id===str(req.body?.requestId,128));
      if(!rf || !['REQUESTED','PROCESSING'].includes(rf.status)) return res.status(404).json({error:'환불 요청 없음 또는 처리됨'});
      const p=ledger.payments[rf.paymentId];if(!p || p.status!=='PAID')return res.status(409).json({error:'결제 상태 확인 필요'});
      if(rf.status==='PROCESSING') return res.status(409).json({error:'이전 환불 처리 결과가 불확실합니다. PG 콘솔에서 확인해 주세요.'});
      rf.status='PROCESSING';save(ledger);
      let completed=false;
      if(p.provider==='demo') completed=true;
      else {
        const result=await portone('/payments/'+encodeURIComponent(p.paymentId)+'/cancel',{method:'POST',body:{reason:'고객 요청: '+str(rf.reason,80)}});
        if(result.cancellation?.status==='SUCCEEDED') completed=true;
        else if(result.cancellation?.status==='FAILED') {rf.status='REQUESTED';save(ledger);throw new Error('PG 환불이 거절되었습니다. 관리자 콘솔 확인 필요');}
        // REQUESTED is asynchronous — no immediate refund confirmation.
      }
      if(completed){rf.status='REFUNDED';rf.refundedAt=iso();p.status='REFUNDED';p.refundedAt=iso();
        const sub=stateOf(ledger,rf.userId);if(sub && sub.periodStart && Date.parse(p.paidAt)>=Date.parse(sub.periodStart)-1000){
          if(sub.autoRenew) await cancelRenewal(ledger,rf.userId);
          sub.refunded=true;save(ledger);syncPlan(sub,rf.userId);
        }
      } else save(ledger);
      return res.json({ok:true,status:rf.status});
    }catch(e){return msgErr(res,e);}
  });
  // Payment notifications are untrusted. Re-query the PG and match ONLY pre-existing IDs.
  app.post('/api/scorepath-commerce/portone-webhook',async(req,res)=>{
    try{
      if(!realConfigured)return res.status(404).end();
      const paymentId=str(req.body?.data?.paymentId,128);
      if(!paymentId) return res.status(200).end();
      const ledger=load();if(!Object.hasOwn(ledger.payments,paymentId))return res.status(200).end();
      const p=ledger.payments[paymentId];
      if(p.status==='PAID' || p.status==='REFUNDED')return res.status(200).end();
      await verifyAndApply(ledger,paymentId);
      return res.status(200).end();
    }catch(e){console.error('[commerce] webhook reconcile error:',e.message);return res.status(503).end();}
  });
  // Self-service deletion; cancels future billing before deleting personal account.
  app.post('/api/scorepath-commerce/delete-account',requireAuth,async(req,res)=>{
    try {
      const user=req.currentUser;const password=str(req.body?.password,100);
      if(!password || !await bcrypt.compare(password,user.passwordHash)) return res.status(403).json({error:'비밀번호가 일치하지 않습니다.'});
      const ledger=load();const sub=stateOf(ledger,user.id);
      if(sub?.pendingPaymentId)return res.status(409).json({error:'처리 중인 결제가 있어 탈퇴할 수 없습니다. 결제 내역 확인이 필요합니다.'});
      if(sub?.autoRenew) await cancelRenewal(ledger,user.id);
      const db=readDb();const found=db.users.find(u=>u.id===user.id);
      if(!found)return res.status(404).json({error:'계정을 찾을 수 없습니다.'});
      const imageKeys=[...(found.notes||[]),...(found.solvedNotes||[]),...(found.trashNotes||[])]
        .map(n=>String(n.problemImageKey||'')).filter(k=>k.startsWith('problem-images/'));
      const unique=[...new Set(imageKeys)];
      const otherKeys=new Set(db.users.filter(u=>u.id!==user.id).flatMap(u=>[...(u.notes||[]),...(u.solvedNotes||[]),...(u.trashNotes||[])].map(n=>n.problemImageKey)));
      db.users=db.users.filter(u=>u.id!==user.id);writeDb(db);
      // Billing/transaction records retained for mandatory transaction evidence, but no name/email.
      if(sub){sub.deletedAt=iso();sub.autoRenew=false;sub.billingKeyCipher=null;save(ledger);}
      const failures=[];
      for(const key of unique){if(otherKeys.has(key))continue;
        try{await r2Client.send(new DeleteObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:key}));}
        catch(e){failures.push(key);console.error('[commerce] R2 delete failed:',e.message);}
      }
      if(failures.length){
        const retry={at:iso(),keys:failures};
        if(neonStore) neonStore.appendDeletionRetry(retry);
        else fs.appendFileSync(path.join(dataDir,'scorepath-deletion-retry.jsonl'),JSON.stringify(retry)+'\n',{mode:0o600});
      }
      req.session.destroy(()=>res.json({ok:true,message:failures.length?'계정 삭제 완료. 일부 사진은 운영자가 추가 삭제 예정입니다.':'계정과 학습 기록을 삭제했습니다.'}));
    }catch(e){return msgErr(res,e);}
  });
  console.log('[ScorePath commerce] 결제 모드:',realConfigured?'portone('+config.pgEnv+')': '로컬 데모 가능 / 실제 결제 비활성');
  return {validPaid, ensurePaidAccess};
}
