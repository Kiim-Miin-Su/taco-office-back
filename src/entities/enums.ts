/** @file-guide
 * 목적: enums.ts — CLASS_MODE_T_VALUES, ClassModeT, CONS_SHARE_T_VALUES, ConsShareT, CPL_AREA_T_VALUES 등 (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * DB enum — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 * 손으로 고치지 마세요. dbml 을 고치고 `npm run entities:gen` 을 다시 도세요.
 */

export const CLASS_MODE_T_VALUES = ['offline', 'online'] as const;
export type ClassModeT = (typeof CLASS_MODE_T_VALUES)[number];

export const CONS_SHARE_T_VALUES = ['all', 'money_only', 'picked', 'private'] as const;
export type ConsShareT = (typeof CONS_SHARE_T_VALUES)[number];

export const CPL_AREA_T_VALUES = ['lesson', 'intake', 'book', 'schedule', 'teacher'] as const;
export type CplAreaT = (typeof CPL_AREA_T_VALUES)[number];

export const GUIDE_STATE_T_VALUES = ['draft', 'ready', 'sent', 'read'] as const;
export type GuideStateT = (typeof GUIDE_STATE_T_VALUES)[number];

export const INV_STATE_T_VALUES = ['draft', 'sent', 'unpaid', 'partial', 'paid', 'void'] as const;
export type InvStateT = (typeof INV_STATE_T_VALUES)[number];

export const KIND_GRP_T_VALUES = ['lesson', 'intake', 'meeting'] as const;
export type KindGrpT = (typeof KIND_GRP_T_VALUES)[number];

export const REP_STATE_T_VALUES = ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'] as const;
export type RepStateT = (typeof REP_STATE_T_VALUES)[number];

export const ROLE_T_VALUES = ['teacher', 'manager', 'admin', 'ceo'] as const;
export type RoleT = (typeof ROLE_T_VALUES)[number];

export const SUG_CAT_T_VALUES = ['lesson', 'pay', 'schedule', 'etc'] as const;
export type SugCatT = (typeof SUG_CAT_T_VALUES)[number];

export const SUG_STATE_T_VALUES = ['open', 'reviewing', 'done'] as const;
export type SugStateT = (typeof SUG_STATE_T_VALUES)[number];

export const TODO_SRC_T_VALUES = ['meeting', 'complaint', 'consulting', 'plan', 'manual'] as const;
export type TodoSrcT = (typeof TODO_SRC_T_VALUES)[number];
