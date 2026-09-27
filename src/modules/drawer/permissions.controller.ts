/** @file-guide
 * 목적: permissions.controller.ts — PermissionsController (controller · §76 권한 창의 표와 문장)
 * 책임/재사용: 판정은 `common/perm` 의 `permissionTable`(= permsOf) 한 곳에 위임한다. 역할을 여기서 비교하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §76 권한 — 상단 「권한」 창과 옛 공유 URL `/permissions` 가 같은 응답을 그린다 (N-98 채택 · W11).
 *
 * 전에는 열네 줄과 「N가지 가능」을 **화면이 들고 세었다.** 표는 서버의 권한 모형(`permsOf`)과 따로 놀 수 있었고,
 * 원문 상자의 역할 설명 줄은 옛 직함 낱말이라 옮길 수 없었다. 이제 줄 · 수 · 부제 · 역할 설명이 전부 여기서 나온다.
 * 서랍과 같은 모듈에 둔다 — 권한 창은 서랍처럼 어느 화면에서나 여는 셸 부품이고, 새 모듈을 세울 만한 표면이 아니다.
 */
import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto } from '../../common/http.dto';
import { Perm, isRole, permissionTable, type RequestUser } from '../../common/perm';
import { PermissionTableDto } from './drawer.dto';

@ApiTags('drawer')
@Controller('permissions')
export class PermissionsController {
  @Get()
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '§76 권한 — 이 사람의 열네 줄 · 가능/잠김 수 · 창 부제 · 역할 설명 줄 (N-98)',
    description: '「지금」 칸은 사람별 예외까지 반영된 결론(permsOf)이다. 역할 설명은 역할의 기본값으로 센다 — 원문 상자의 첫 줄(역할 전환)은 옮기지 않는다.',
  })
  @ApiOkResponse({ type: PermissionTableDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: '관리 화면 권한 없음' })
  table(@CurrentUser() user: RequestUser): PermissionTableDto {
    if (!isRole(user.role)) throw new ForbiddenException({ code: 'FORBIDDEN', message: '역할을 알 수 없습니다' });
    const t = permissionTable(user.role, user.perms);
    return {
      roleLabel: t.roleLabel, possible: t.possible, locked: t.locked, sub: t.sub, roleNotes: t.roleNotes,
      rows: t.rows.map((r) => ({ key: r.key, feature: r.feature, what: r.what, who: r.who, perm: r.perm, allowed: r.allowed })),
    };
  }
}
