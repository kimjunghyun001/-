/* ScorePath beta checkout surface. It never collects credit-card numbers. */
(() => {
  'use strict';
  const $ = (s, root=document) => root.querySelector(s);
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => Number(n || 0).toLocaleString('ko-KR') + '원';
  const date = n => n ? new Date(n).toLocaleString('ko-KR') : '없음';
  const api = async (url, method='GET', body) => {
    const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error || `요청 오류 ${response.status}`);
    return data;
  };
  let ready=false;
  let state=null;
  async function refresh() {
    const p=$('#spCommercePricingV01');if(!p)return;
    try {
      state=await api('/api/scorepath-commerce/status');
      const target=$('#spCommerceStatusV01');if(!target)return;
      const modeLabel=state.mode==='demo'?'로컬 모의 결제 (실제 청구 0원)':state.mode==='portone'?'포트원 정기결제': '결제 계약/설정 전 (결제 불가)';
      target.textContent=`모드: ${modeLabel} · ${state.active?'구독 이용 중':'유료 구독 없음'} · ${state.periodEnd?'이용기간 종료: '+date(state.periodEnd):''} · ${state.autoRenew?'다음 자동결제 예정':'자동갱신 없음'}`;
      const subscribe=$('#spCommerceSubscribeV01');
      if(subscribe) {subscribe.disabled=state.mode==='disabled'||state.active;subscribe.textContent=state.mode==='demo'?'모의 결제하기 (실제 청구 0원)':state.mode==='disabled'?'PG 계약 준비 중':'월 9,900원 구독 결제';}
      $('#spCommerceCancelV01').disabled=!state.autoRenew;
      const oldPricing = Array.from($('#spHubPricingV01')?.querySelectorAll('.sp-note') || [])
        .find(el=>el.textContent.includes('현재 결제 연동 준비 중'));
      if (oldPricing) oldPricing.textContent = state.mode === 'portone'
        ? '정기결제: 처음 9,900원 청구, 이후 매월 갱신. 해지는 내 정보에서 가능합니다.'
        : state.mode === 'demo'
          ? '로컬 모의 결제 전용(실제 청구 0원). 실제 결제는 PG 계약 및 정책 확정 후 가능합니다.'
          : '실제 결제는 현재 준비 중입니다. PG 계약 및 법적 문서 확정이 필요합니다.';
      await refreshHistory();
    } catch(e) { const x=$('#spCommerceStatusV01'); if(x)x.textContent='결제 상태를 불러오지 못했습니다: '+e.message; }
  }
  async function refreshHistory() {
    const list=$('#spCommerceHistoryV01'); if(!list)return;
    const data=await api('/api/scorepath-commerce/history');
    const payments=data.payments || [];
    list.innerHTML=payments.length?payments.map(p=>`<div class="sp-commerce-line"><span>${safe(date(p.createdAt))} · ${safe(p.provider)} · ${safe(p.status)} · ${safe(money(p.amount))}</span> <small>${safe(p.paymentId)}</small>${p.status==='PAID'?`<button type="button" data-sp-refund="${safe(p.paymentId)}">이 결제 환불 신청</button>`:''}</div>`).join(''):'<p>결제 내역이 없습니다.</p>';
    const box=$('#spCommerceRefundStatusV01');if(box)box.innerHTML=(state?.refunds||[]).map(r=>`<div>환불 신청 ${safe(r.id)} · ${safe(r.status)} (${safe(date(r.createdAt))})</div>`).join('')||'환불 신청 내역이 없습니다.';
  }
  async function updateDashboard() {
    // Existing ScorePath implementation updates all account statistics.
    try {const data=await api('/api/auth/me');if(typeof renderDashboard==='function') renderDashboard(data.dashboard);}catch{}
  }
  let portonePromise;
  function loadPortOne() {
    if(window.PortOne)return Promise.resolve(window.PortOne);
    if(!portonePromise)portonePromise=new Promise((resolve,reject)=>{
      const s=document.createElement('script');s.src='https://cdn.portone.io/v2/browser-sdk.js';s.onload=()=>window.PortOne?resolve(window.PortOne):reject(new Error('PG SDK를 불러오지 못했습니다.'));s.onerror=()=>reject(new Error('PG SDK 연결 오류'));document.head.appendChild(s);
    });
    return portonePromise;
  }
  function say(message) { const e=$('#spCommerceActionV01');if(e)e.textContent=message; }
  async function doSubscribe() {
    if(!state)await refresh();
    if(!$('#spCommerceAgreeTermsV01').checked || !$('#spCommerceAgreeBillingV01').checked)
      throw new Error('이용약관·환불 안내와 자동결제 조건을 각각 확인하고 동의해 주세요.');
    if(state.mode==='disabled')throw new Error('결제대행사 계약 전에는 실제 결제를 할 수 없습니다.');
    const wantsReal=state.mode==='portone';
    if(wantsReal && !confirm('월 9,900원 정기결제를 신청합니다. 카드 등록 후 최초 9,900원이 결제되고, 해지 전까지 매월 갱신될 수 있습니다. 계속할까요?'))return;
    if(!wantsReal && !confirm('실제 카드 결제가 아닌 로컬 모의 결제입니다. 실제 청구는 0원입니다. 계속할까요?'))return;
    let billingKey='';
    if(wantsReal){
      const sdk=await loadPortOne();
      const result=await sdk.requestIssueBillingKey({storeId:state.storeId,channelKey:state.channelKey,billingKeyMethod:'CARD'});
      if(result.code!==undefined)throw new Error(result.message||'결제수단 등록이 취소되었습니다.');
      billingKey=result.billingKey;
      if(!billingKey)throw new Error('PG 빌링키 발급 실패');
    }
    const r=await api('/api/scorepath-commerce/subscribe','POST',{billingKey,agreedPolicyVersion:state.policyVersion,confirmedAutoRenew:true});
    say(r.note||'구독 처리가 완료되었습니다.');
    await refresh();await updateDashboard();
  }
  async function cancel(){
    if(!confirm('다음 자동결제를 중단할까요? 이미 결제한 이용기간은 유지됩니다.'))return;
    const r=await api('/api/scorepath-commerce/cancel','POST',{});say(r.message);await refresh();
  }
  async function refund(paymentId){
    const reason=prompt('환불 사유를 입력하세요. 환불은 운영자의 검토 후 처리되며, 신청 즉시 결제가 취소되는 것은 아닙니다.');
    if(reason===null)return;
    const r=await api('/api/scorepath-commerce/refund-request','POST',{paymentId,reason});say(r.message);await refresh();
  }
  async function removeAccount(){
    if(!confirm('계정을 삭제하면 학습 기록을 복구하기 어려울 수 있습니다. 구독 자동갱신은 취소됩니다. 계속할까요?'))return;
    const password=prompt('확인을 위해 현재 비밀번호를 입력하세요.');
    if(password===null)return;
    if(!confirm('마지막 확인: ScorePath 계정과 학습 기록을 삭제할까요?'))return;
    const r=await api('/api/scorepath-commerce/delete-account','POST',{password});alert(r.message);location.reload();
  }
  function attach() {
    const hub=$('#cardScorePathMemberHubV01');if(!hub||$('#spCommercePricingV01'))return;
    if(!$('#spCommerceStylesV01')){
      const style=document.createElement('style');style.id='spCommerceStylesV01';style.textContent=`
        #cardScorePathMemberHubV01 button.sp-hub-logout { color:#334155 !important; min-width:95px; }
        .sp-commerce-box{padding:14px;border-radius:12px;border:1px solid #cbd5e1;background:#f8fafc;margin:14px 0;line-height:1.7;color:#1e293b}
        .sp-commerce-box h3{margin:0 0 10px;font-size:17px}
        .sp-commerce-box label{display:block;font-size:14px;line-height:1.5;margin:8px 0}
        .sp-commerce-box label input[type=checkbox]{width:auto;margin:0 6px 0 0}
        .sp-commerce-box button {background:#1d4ed8;color:#fff;border-radius:9px;padding:9px 13px;margin:5px 5px 5px 0;font-size:13px}
        .sp-commerce-box button:disabled{background:#94a3b8}
        .sp-commerce-box button.sp-warn{background:#b91c1c}
        .sp-commerce-box a{color:#1d4ed8;text-decoration:underline}
        .sp-commerce-line{border-top:1px solid #cbd5e1;display:flex;gap:7px;flex-wrap:wrap;padding:8px 0;align-items:center;justify-content:space-between;font-size:13px;word-break:break-all}
        #spCommerceActionV01{font-weight:700;color:#1e3a8a;white-space:pre-wrap}
      `;document.head.appendChild(style);
    }
    const pricing=$('#spHubPricingV01',hub),privacy=$('#spHubPrivacyV01',hub);
    if(!pricing||!privacy)return;
    const box=document.createElement('section');box.id='spCommercePricingV01';box.className='sp-commerce-box';
    box.innerHTML=`<h3>💳 구독 신청 · 결제 확인</h3>
      <p id="spCommerceStatusV01">결제 상태 확인 중...</p>
      <p><a target="_blank" rel="noopener" href="/legal/terms.html">이용약관</a> · <a target="_blank" rel="noopener" href="/legal/privacy.html">개인정보 처리방침</a> · <a target="_blank" rel="noopener" href="/legal/refund.html">환불·청약철회</a> · <a target="_blank" rel="noopener" href="/legal/subscription.html">구독·자동결제 안내</a></p>
      <label><input id="spCommerceAgreeTermsV01" type="checkbox">이용약관 및 환불·청약철회 안내를 읽고 동의합니다.</label>
      <label><input id="spCommerceAgreeBillingV01" type="checkbox">월 9,900원 최초 결제 및 해지 전 매월 자동갱신에 동의합니다.</label>
      <button type="button" id="spCommerceSubscribeV01">결제 정보 확인 중</button><button type="button" id="spCommerceSyncV01">결제 상태 재확인</button>
      <p><small>모의 결제는 실제 청구 0원입니다. 실제 PG 결제는 계약·상점정보·HTTPS·정책 확정 후에만 열립니다.</small></p>
      <div id="spCommerceActionV01" role="status"></div>`;
    pricing.appendChild(box);
    const manage=document.createElement('section');manage.className='sp-commerce-box';manage.id='spCommerceManagementV01';
    manage.innerHTML=`<h3>🧾 구독·해지·환불·결제 내역</h3>
      <p>자동결제를 해지해도 이미 결제한 기간은 유지됩니다. 환불 신청은 운영자의 확인이 필요합니다.</p>
      <button type="button" id="spCommerceCancelV01" class="sp-warn">다음 자동결제 해지</button>
      <button type="button" id="spCommerceReloadV01">내역 새로고침</button>
      <div id="spCommerceHistoryV01">조회 중...</div>
      <h4>환불 신청 처리 상태</h4><div id="spCommerceRefundStatusV01">조회 중...</div>
      <p><small>고객 문의: 서비스 사업자 연락처는 정식 공개 전 등록해야 합니다.</small></p>
      <h3>계정 탈퇴</h3><p>삭제 전 결제와 법적 보관 정보 처리 안내를 확인하세요.</p>
      <button type="button" id="spCommerceDeleteV01" class="sp-warn">비밀번호 확인 후 계정 탈퇴</button>`;
    privacy.appendChild(manage);
    // The old beta notice is no longer an accurate list of available features. Keep as history but hide it.
    const old=Array.from(privacy.querySelectorAll('.sp-privacy-box')).find(x=>x.textContent.includes('현재 앱 내 이메일 변경'));
    if(old)old.innerHTML='<h4>📄 법적 안내 (준비 중)</h4><p>정식 개인정보 처리방침·이용약관·환불 정책은 위 링크에서 확인하세요. 개인정보의 보유기간·위탁처리·사업자 정보는 공개 전 운영자가 검토·확정해야 합니다.</p>';
    $('#spCommerceSubscribeV01').addEventListener('click',()=>doSubscribe().catch(e=>say(e.message)));
    $('#spCommerceCancelV01').addEventListener('click',()=>cancel().catch(e=>say(e.message)));
    $('#spCommerceSyncV01').addEventListener('click',()=>api('/api/scorepath-commerce/sync','POST',{}).then(refresh).then(updateDashboard).catch(e=>say(e.message)));
    $('#spCommerceReloadV01').addEventListener('click',()=>refresh().catch(e=>say(e.message)));
    $('#spCommerceDeleteV01').addEventListener('click',()=>removeAccount().catch(e=>say(e.message)));
    $('#spCommerceHistoryV01').addEventListener('click',ev=>{const b=ev.target.closest('[data-sp-refund]');if(b)refund(b.dataset.spRefund).catch(e=>say(e.message));});
    // Hide old disabled '결제 준비 중' button only; these new controls clearly label their actual mode.
    Array.from(pricing.querySelectorAll('button')).filter(b=>b.disabled && b.textContent.includes('결제 준비')).forEach(b=>b.hidden=true);
    void refresh();
  }
  function readyOnce() {
    if(ready)return;ready=true;
    attach();
    const obs=new MutationObserver(()=>{if($('#cardScorePathMemberHubV01') && !$('#spCommercePricingV01'))attach();});
    obs.observe(document.body,{childList:true,subtree:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',readyOnce);
  else readyOnce();
})();
