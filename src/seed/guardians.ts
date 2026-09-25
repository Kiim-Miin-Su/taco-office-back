/** @file-guide
 * 목적: guardians.ts — GUARDIANS (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보호자 — DQ3 (2026-09-25). **가짜 연락처만** 쓴다 — 메일은 example.com, 휴대폰은 010-0000-00xx.
 * 실제로 보낼 설정이 있는 환경에서 시드가 누군가에게 닿으면 안 된다.
 *
 * 고른 학생: §43 회차 학부모 안내가 걸린 학생(5·18·15·19)과 둘을 더 — 한 명 · 두 명 · 문자만 · 메일만이
 * 다 들어 있어야 발송 창의 「받지 않는 채널 건너뜀」과 대표 미리 체크를 화면에서 볼 수 있다.
 * 휴대폰은 숫자만 적는다(`notify/sender.phoneDigits` 가 저장하는 모양).
 */
export const GUARDIANS = [
  { studentId: 1,  name: '김지현', relation: '어머니', email: 'parent01@example.com', phone: '01000000001', receiveEmail: true,  receiveSms: true,  isPrimary: true },
  { studentId: 1,  name: '김태호', relation: '아버지', email: 'parent02@example.com', phone: null,          receiveEmail: true,  receiveSms: false, isPrimary: false },
  { studentId: 2,  name: '박수연', relation: '어머니', email: 'parent03@example.com', phone: '01000000003', receiveEmail: true,  receiveSms: false, isPrimary: true },
  { studentId: 5,  name: '오정민', relation: '아버지', email: null,                   phone: '01000000005', receiveEmail: false, receiveSms: true,  isPrimary: true },
  { studentId: 15, name: '백은주', relation: '어머니', email: 'parent15@example.com', phone: '01000000015', receiveEmail: true,  receiveSms: true,  isPrimary: true },
  { studentId: 18, name: '문현주', relation: '어머니', email: 'parent18@example.com', phone: '01000000018', receiveEmail: true,  receiveSms: false, isPrimary: true },
  { studentId: 18, name: '문성진', relation: '아버지', email: 'parent19@example.com', phone: '01000000019', receiveEmail: true,  receiveSms: true,  isPrimary: false },
  { studentId: 19, name: '권미영', relation: '보호자', email: 'parent20@example.com', phone: null,          receiveEmail: true,  receiveSms: false, isPrimary: true },
] as const;
