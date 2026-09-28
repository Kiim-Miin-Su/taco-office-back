/** @file-guide
 * 목적: 인증 파일 응답이 민감 본문을 브라우저/중간 캐시에 남기지 않는지 검증한다.
 * 책임/재사용: 실제 FilesController 헤더 계약만 보고 FILE ACL은 files-db.spec.ts가 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { Response } from 'express';
import { FilesController } from '../src/modules/files/files.controller';
import type { FilesService } from '../src/modules/files/files.service';

describe('민감 파일 다운로드 헤더', () => {
  it('계약서·영수증·리포트 공용 경로는 no-store다', async () => {
    const readAuthorized = jest.fn().mockResolvedValue({
      kind: 'expense-receipt', name: '영수증.png', mime: 'image/png', data: Buffer.from('png'),
    });
    const controller = new FilesController({ readAuthorized } as unknown as FilesService);
    const set = jest.fn();
    await controller.download(
      { id: 7, name: '대표', role: 'ceo' },
      11,
      { set } as unknown as Response,
    );
    expect(readAuthorized).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 11);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }));
  });
});
