/** @file-guide
 * 목적: schedule.references.ts — assertScheduleReferences (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';
import type { State } from '../../lib/recurrence';

/**
 * reducer의 최종 참조를 한 번씩 읽는다. 같은 transaction의 KEY SHARE가 검사~저장 사이
 * 부모 삭제/키 변경을 막는다. 저장 이후 직접 삭제 방어는 실제 FK가 추가로 필요하다.
 * nullable 미지정과 비활성 자원의 과거 참조는 보존한다. STAFF role을 강사로 제한하지 않는다.
 */
export async function assertScheduleReferences(q: QueryRunner, state: State): Promise<void> {
  const teachers = [...state.SER.map(s => s.teacherId), ...state.EXC.map(e => e.teacherId)];
  const rooms = [...state.SER.map(s => s.roomId), ...state.EXC.map(e => e.roomId)];
  const students = [...state.SER_STU.map(s => s.studentId), ...state.EXC.flatMap(e => e.stuOut ?? [])];
  // 식별자/SQL은 이 고정 목록에서만 온다. 사용자 값은 항상 parameter로 전달한다.
  const groups = [
    { sql: 'SELECT key AS value FROM kind WHERE key = ANY($1::text[]) ORDER BY key FOR KEY SHARE', values: state.SER.map(s => s.kind), label: '수업 종류' },
    { sql: 'SELECT key AS value FROM sub WHERE key = ANY($1::text[]) ORDER BY key FOR KEY SHARE', values: state.SER.map(s => s.sub), label: '과목' },
    { sql: 'SELECT id AS value FROM staff WHERE id = ANY($1::bigint[]) ORDER BY id FOR KEY SHARE', values: teachers, label: '담당 직원' },
    { sql: 'SELECT id AS value FROM room WHERE id = ANY($1::bigint[]) ORDER BY id FOR KEY SHARE', values: rooms, label: '강의실' },
    { sql: 'SELECT id AS value FROM stu WHERE id = ANY($1::bigint[]) ORDER BY id FOR KEY SHARE', values: students, label: '학생' },
  ];
  for (const group of groups) {
    const values = [...new Set(group.values.filter(v => v != null).map(String))];
    if (!values.length) continue;
    const rows = await q.query(group.sql, [values]) as Array<{ value: string | number }>;
    const found = new Set(rows.map(r => String(r.value)));
    if (values.some(v => !found.has(v))) {
      // 기존 FK 오류와 같은 code/HTTP 형식. 내부 테이블명·ID 목록은 공개하지 않는다.
      throw new BadRequestException({ code: 'REFERENCE_NOT_FOUND', message: `연결하려는 ${group.label} 대상이 없습니다` });
    }
  }
}
