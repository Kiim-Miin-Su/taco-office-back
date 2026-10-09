/** @file-guide
 * 목적: TBO-55 BOC-11F 교재 판매 생성·취소 DTO의 변환·검증 계약을 회귀한다. (test)
 * 책임/재사용: runtime writer 전에 생성 OpenAPI와 같은 경계값이 유효한지만 검증한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11F-BOOK-SALES-FEES-2026-10-09.md · taco-contract-sync
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BookSaleCancelDto, BookSaleCreateDto } from '../src/modules/accounting/accounting.dto';

const key = '11111111-1111-4111-8111-111111111111';

describe('BOC-11F book sales contract', () => {
  it('HTTP 정수 문자열을 변환하고 계좌·현금 판매만 받는다', async () => {
    const dto = plainToInstance(BookSaleCreateDto, {
      studentId: '7', bookId: '31', soldOn: '2026-10-09', quantity: '2', unitPrice: '25000',
      paymentMethod: 'transfer', memo: '수업용 교재', requestKey: key,
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto).toMatchObject({ studentId: 7, bookId: 31, quantity: 2, unitPrice: 25_000 });
  });

  it('원문에 없는 카드·수량 0·음수 단가를 거절한다', async () => {
    const dto = plainToInstance(BookSaleCreateDto, {
      studentId: 7, bookId: 31, soldOn: '2026-10-09', quantity: 0, unitPrice: -1,
      paymentMethod: 'card', requestKey: key,
    });
    const fields = (await validate(dto)).map((error) => error.property);

    expect(fields).toEqual(expect.arrayContaining(['quantity', 'unitPrice', 'paymentMethod']));
  });

  it('취소는 version·사유·멱등키를 모두 요구한다', async () => {
    const valid = plainToInstance(BookSaleCancelDto, { expectedVersion: '1', reason: '중복 판매 정정', requestKey: key });
    await expect(validate(valid)).resolves.toEqual([]);

    const invalid = plainToInstance(BookSaleCancelDto, { expectedVersion: 0, reason: ' ', requestKey: 'bad-key' });
    const fields = (await validate(invalid)).map((error) => error.property);
    expect(fields).toEqual(expect.arrayContaining(['expectedVersion', 'reason', 'requestKey']));
  });
});
