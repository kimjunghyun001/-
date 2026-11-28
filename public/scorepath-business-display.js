/* 사업자 정보 공통 표시기: 홈페이지·법적 문서에서 같은 값을 사용합니다. */
(function(){
  'use strict';
  function ready(fn){
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn);
    else fn();
  }
  function clean(x){return typeof x==='string'?x.trim():'';}
  ready(function(){
    var info=window.SCOREPATH_BUSINESS_INFO||{};
    var required=['legalBusinessName','representativeName','businessRegistrationNumber','businessAddress','supportPhone','supportEmail'];
    var incomplete=required.some(function(k){return !clean(info[k]);});
    var fieldLabels={
      legalBusinessName:'입력 필요', representativeName:'입력 필요',
      businessRegistrationNumber:'입력 필요',businessAddress:'입력 필요',
      supportPhone:'입력 필요', supportEmail:'입력 필요',
      mailOrderStatus:'신고·면제 여부 확인 필요', hostingProvider:'입력 필요'
    };
    var contact=[clean(info.supportEmail),clean(info.supportPhone)].filter(Boolean).join(' / ');
    var summary=[
      '운영 사업자: '+(clean(info.legalBusinessName)||'입력 필요'),
      '대표자: '+(clean(info.representativeName)||'입력 필요'),
      '사업자등록번호: '+(clean(info.businessRegistrationNumber)||'입력 필요'),
      '주소: '+(clean(info.businessAddress)||'입력 필요'),
      '고객지원: '+(contact||'입력 필요')
    ].join(' · ');
    var all=document.querySelectorAll('[data-spbiz]');
    all.forEach(function(el){
      var key=el.getAttribute('data-spbiz');
      var value=key==='summary'?summary:key==='supportCombined'?(contact||'입력 필요'):(clean(info[key])||fieldLabels[key]||'입력 필요');
      el.textContent=value; // HTML 삽입 방지
      if(key==='supportEmail' && value!=='입력 필요' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)){
        var a=document.createElement('a');a.href='mailto:'+value;a.textContent=value;
        el.textContent='';el.appendChild(a);
      }
    });
    document.querySelectorAll('[data-spbiz-incomplete]').forEach(function(el){
      if(incomplete)el.classList.add('spbiz-show');
    });
  });
})();
