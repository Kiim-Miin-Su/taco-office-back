/** @file-guide
 * 목적: 교재 배정·파일 다운로드·강사 안내가 공유하는 현재 또는 장래 수업 문맥 SQL.
 * 책임/재사용: SER/SER_STU의 기간 교집합과 lesson 문맥만 소유한다. FILE·ISSUE 상태와 actor 권한은 호출자가 판정한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** 별칭·표현식은 소스의 내부 상수만 받는다. 요청 값은 호출자가 $n 바인딩으로 넘긴다. */
export function bookAssignmentPeriodSql(ser: string, roster: string, today: string): string {
  return `GREATEST(${ser}.from_date,COALESCE(${roster}.from_date,${ser}.from_date),${today}::date)
          <= LEAST(COALESCE(${ser}.to_date,'infinity'::date),COALESCE(${roster}.to_date,'infinity'::date))`;
}

/**
 * 실제 강사·학생·과목이 일치하는 현재/장래 수업 한 건. SQL 표현식은 내부 상수만 허용한다.
 * writer는 같은 SELECT에 행 잠금을 요청하고, 읽기는 EXISTS로 재사용해 과거 배정 스냅샷만으로 열지 않는다.
 */
export function bookAssignmentContextSql(input: {
  teacherId: string;
  subKey: string;
  studentId: string;
  today: string;
  lock?: boolean;
}): string {
  return `SELECT book_ser.id FROM ser book_ser
            JOIN kind book_kind ON book_kind.key=book_ser.kind_key AND book_kind.grp='lesson'
            JOIN ser_stu book_roster ON book_roster.ser_id=book_ser.id
           WHERE book_ser.teacher_id=${input.teacherId} AND book_ser.sub_key=${input.subKey}
             AND book_roster.student_id=${input.studentId}
             AND ${bookAssignmentPeriodSql('book_ser', 'book_roster', input.today)}
           ORDER BY book_ser.id LIMIT 1${input.lock ? ' FOR KEY SHARE OF book_ser,book_roster' : ''}`;
}
