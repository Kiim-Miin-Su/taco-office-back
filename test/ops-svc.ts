/** @file-guide
 * 목적: ops-svc.ts — makeOpsService (test)
 * 책임/재사용: 생성자 의존만 채운다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * `OpsService` 는 **읽기**(목록·건수)와 **쓰기**(C96 회의 잡기) 둘을 갖는다.
 * 읽기만 보는 스위트가 시간표·줌까지 세울 까닭은 없다. 그래서 여기서 **부르면 터지는** 자리를 준다 —
 * 조용히 `undefined` 를 넘기면 회의 잡기를 건드린 스위트가 통과해 버리고, 그건 거짓 초록이다.
 * 회의 잡기를 보는 스위트는 `test/ops-create-c96.spec.ts` 처럼 **HTTP 로** 본다(전체 모듈이 선다).
 */
import type { Repository } from 'typeorm';
import { OpsService } from '../src/modules/ops/ops.service';
import type { Lead } from '../src/entities/lead.entity';

const absent = (what: string) =>
  new Proxy({}, {
    get(_t, prop) {
      return () => {
        throw new Error(`${what}.${String(prop)} 는 이 스위트에 없다 — 회의 잡기는 HTTP 스위트에서 본다`);
      };
    },
  });

export function makeOpsService(lead: unknown): OpsService {
  return new OpsService(
    lead as Repository<Lead>,
    absent('ScheduleWriteService') as never,
    absent('ZoomService') as never,
  );
}
