/** @file-guide
 * 목적: schedule-time-guard.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { ArgumentsHost } from '@nestjs/common';
import { scheduleTimeIssue, type State } from '../src/lib/recurrence';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
const state = (): State => ({SER:[{id:1,kind:'meeting',sub:null,mode:'offline',title:'',teacherId:null,roomId:null,
  startMin:621,endMin:660,rrule:'DAILY',fromDate:'2026-09-11',toDate:null}],SER_STU:[],EXC:[{
  id:1,serId:1,onDate:'2028-09-11',canceled:false,newDate:null,startMin:null,endMin:630,
  teacherSet:false,teacherId:null,roomSet:false,roomId:null,reason:null,stuOut:[]} ]});
describe('최종 상태 시간 상속 및 공용 오류',()=>{
  it('투영 horizon 밖 예외도 원본과 합쳐 검사하며 상태는 변경하지 않는다',()=>{
    const s=state(); const before=JSON.stringify(s); expect(scheduleTimeIssue(s)).not.toBeNull(); expect(JSON.stringify(s)).toBe(before);
  });
  it('취소된 회차도 투영 시간값은 검사한다',()=>{const s=state();s.EXC[0].canceled=true;expect(scheduleTimeIssue(s)).not.toBeNull();});
  it('null은 원본 상속으로 복원하며 자정 종료를 허용한다',()=>{
    const s=state();s.SER[0].startMin=1430;s.SER[0].endMin=1440;s.EXC[0].endMin=null;expect(scheduleTimeIssue(s)).toBeNull();
  });
  it('기간 밖 이력과 첫 회차 취소의 종료일 역전을 금지하지 않는다',()=>{
    const s=state();s.SER[0].toDate='2026-09-10';expect(scheduleTimeIssue(s)).toBeNull();
  });
  it.each(['ser_time_check','exc_time_check','ser_occ_time_check','payout_net_nonneg'])('%s 오류를 공용 형식으로만 반환한다',constraint=>{
    const response={status:jest.fn().mockReturnThis(),json:jest.fn()};
    const host={switchToHttp:()=>({getResponse:()=>response})} as unknown as ArgumentsHost;
    new ApiErrorFilter().catch({code:'23514',constraint,detail:'private row data'},host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({code:constraint==='payout_net_nonneg'?'INVALID_AMOUNT':'BAD_RANGE',message:expect.any(String)});
  });
});
