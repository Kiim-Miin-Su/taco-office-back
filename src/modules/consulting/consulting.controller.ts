/** @file-guide
 * 목적: consulting.controller.ts — ConsultingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ConsAccountingDto, ConsAccountRowDto, ConsItemDto, ConsItemToggleDto,
  ConsPaymentCreateDto, ConsStudentsDto, ConsultingListDto,
} from './consulting.dto';
import { ConsultingService } from './consulting.service';

@ApiTags('consulting')
@Controller('consulting')
export class ConsultingController {
  constructor(private readonly svc: ConsultingService) {}

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 — 단계 보드 · 목록 · 회차 기록 (§26 · §27 · §31)',
    description: '최종 canAdminPage와 canCrudAll이 모두 필요하다. 공개 범위로 투영된 items의 stage(contract/running/done)를 클라이언트에서 필터링하며 추가 GET은 0이다. 전체/단계 건수는 같은 items에서 파생하고 금액·상세 공개 권한을 변경하지 않는다.',
  })
  @ApiOkResponse({ type: ConsultingListDto })
  async all(@CurrentUser() user: RequestUser): Promise<ConsultingListDto> {
    if (!isRole(user.role)) return { items: [], canSeeAmounts: false };
    return this.svc.all(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      hasPerm(user.role, 'canHide', user.perms), // §76 — 비공개 컨설팅 열람
    );
  }

  @Patch(':id/items/:itemId')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '진행 항목 체크/해제 — 47D-B 유일 쓰기 (N-18 §4-17)',
    description: '공개 범위(csCanFull)·종료 잠금은 서버가 판정한다. 진행률 숫자는 저장하지 않는다 — 원장 행만 바뀐다.',
  })
  @ApiOkResponse({ type: ConsItemDto })
  @ApiForbiddenResponse({ description: '내용이 공개 범위 밖 (수납만 공개 등)' })
  @ApiNotFoundResponse({ description: '보이지 않는 건·없는 항목 — 존재를 누출하지 않는다' })
  @ApiConflictResponse({ description: 'code ITEM_LOCKED — 종료된 건' })
  async toggleItem(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: ConsItemToggleDto,
  ): Promise<ConsItemDto> {
    // @Perm 가드가 매니저 이상을 이미 보장한다 — isRole 은 타입 좁힘용이다 (all() 과 같은 규약)
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.toggleItem(user.id, canHide, id, itemId, dto);
  }

  /* ══ §28 컨설팅 회계 ═══════════════════════════════════════════════════ */

  @Get('accounting')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 회계 — 계약 금액 · 받은 돈 · 남은 돈 (§28)',
    description:
      '머리 세 칸과 줄의 「남음」을 **서버가 뺀다** (D-R37). 화면이 계약 − 받음을 다시 하면 가려진 줄에서 합계가 갈린다. '
      + "원문 규칙 「수납만 공개(vis='pay')여도 이 화면의 금액은 보입니다」는 새 판정이 아니라 csCanAmount 그대로다.",
  })
  @ApiOkResponse({ type: ConsAccountingDto })
  async accounting(@CurrentUser() user: RequestUser): Promise<ConsAccountingDto> {
    if (!isRole(user.role)) return { items: [], totalAmount: null, totalPaid: null, totalDue: null, canSeeAmounts: false };
    return this.svc.accounting(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      hasPerm(user.role, 'canHide', user.perms),
    );
  }


  @Get('students')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 학생별 — CONS 를 학생 기준으로 재구성 (§27)',
    description:
      '원문 규칙 「**csCan() 으로 볼 수 있는 것만 집계합니다**」 그대로다 — 안 보이는 건은 건수에도 합계에도 안 들어간다. '
      + '기록 회차·끝낸 항목·받은 돈·건수를 **서버가 센다** (D-R37). 화면이 배열 길이를 세면 내용이 잠긴 건에서 「항목 0/0」이 된다. '
      + '한 건에 학생이 여럿이면 그 학생들 모두의 줄에 걸린다(슬라이드 29 「학생 여러 명」).',
  })
  @ApiOkResponse({ type: ConsStudentsDto })
  async students(@CurrentUser() user: RequestUser): Promise<ConsStudentsDto> {
    if (!isRole(user.role)) return { items: [], canSeeAmounts: false };
    return this.svc.students(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      hasPerm(user.role, 'canHide', user.perms),
    );
  }

  @Post(':id/payments')
  @Perm('canAdminPage', 'canCrudAll', 'canMoney')
  @ApiOperation({
    summary: '납부 넣기 — §28 동작 ①',
    description: 'cons_pay 원장에 한 줄 더한다. 받은 합은 저장하지 않는다 — 읽을 때 원장을 더한다 (D-R37).',
  })
  @ApiOkResponse({ type: ConsAccountRowDto, description: '바뀐 줄 하나 — 화면이 숫자를 다시 만들지 않게' })
  @ApiForbiddenResponse({ description: '금액이 공개 범위 밖' })
  @ApiNotFoundResponse({ description: '보이지 않는 건 — 존재를 누출하지 않는다' })
  @ApiConflictResponse({ description: 'code CONS_PAY_LOCKED — 종료된 건' })
  async addPayment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConsPaymentCreateDto,
  ): Promise<ConsAccountRowDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.addPayment(user.id, canMoney, canHide, id, dto);
  }

  @Post(':id/invoice')
  @Perm('canAdminPage', 'canCrudAll', 'canMoney')
  @ApiOperation({
    summary: '청구서로 전환 — §28 동작 ② · 연동 「INV 에 csid 로 연결」',
    description:
      '**남은 돈으로** 청구서를 낸다. 계약 전액으로 내면 이미 받은 돈이 §53 미수금에 한 번 더 얹힌다. '
      + '전환 뒤에도 납부 기록은 cons_pay 에 그대로 남는다 — cs_id 는 연결이지 소유가 아니다.',
  })
  @ApiOkResponse({ type: ConsAccountRowDto })
  @ApiForbiddenResponse({ description: '금액이 공개 범위 밖' })
  @ApiNotFoundResponse({ description: '보이지 않는 건' })
  @ApiConflictResponse({
    description: 'code CONS_INV_EXISTS · CONS_INV_NOT_PAID_STEP · CONS_INV_NOTHING_DUE · CONS_INV_STUDENT_AMBIGUOUS',
  })
  async toInvoice(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ConsAccountRowDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.toInvoice(user.id, canMoney, canHide, id);
  }
}
