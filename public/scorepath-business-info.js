/**
 * ScorePath 공개 사업자 정보 (브라우저에서 누구나 볼 수 있습니다).
 * 여기에 비밀번호, API 키, 정산 계좌번호 등을 절대로 넣지 마세요.
 * 2026-11-30 상호 변경이 처리된 뒤 legalBusinessName만 새 등록 상호로 변경하세요.
 * 빈 문자열("" )은 사이트에서 '입력 필요'로 표시됩니다.
 */
window.SCOREPATH_BUSINESS_INFO = Object.freeze({
  brandName: 'ScorePath',
  legalBusinessName: '오답노트AI', // 현재 사업자등록증에 적힌 상호
  representativeName: '김광영', // 대표자 성명 (사업자등록증 기준)
  businessRegistrationNumber: '640-39-01689', // 000-00-00000 형태
  businessAddress: '서울특별시 관악구 당곡2길 37-3, 1층(봉천동)', // 사업장 주소 (사업자등록증 기준)
  supportPhone: '07079385270', // 실제 응대 가능한 번호
  supportEmail: 'scorepath.support@gamil.com', // 문의 이메일
  mailOrderStatus: '통신판매업 신고 면제 대상(신고번호 없음)',// 신고번호 또는 확인된 면제 관련 표시. 확인 전에는 비워두세요.
  hostingProvider: 'Render'
});