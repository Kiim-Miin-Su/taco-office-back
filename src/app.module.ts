/** @file-guide
 * 목적: app.module.ts — AppModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
// 이름이 우리 ScheduleModule(수업 스케줄)과 겹친다 — 쓰임대로 부른다
import { ScheduleModule as CronModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as Joi from 'joi';
import { dataSourceOptions } from './data-source';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { OnboardingGuard } from './auth/onboarding.guard';
import { PermGuard } from './common/perm';
import { ApiErrorFilter } from './common/filters/api-error.filter';
import { HealthController } from './health.controller';
import { MetaModule } from './modules/meta/meta.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { OpsModule } from './modules/ops/ops.module';
import { ConsultingModule } from './modules/consulting/consulting.module';
import { BoardModule } from './modules/board/board.module';
import { BooksModule } from './modules/books/books.module';
import { GuidesModule } from './modules/guides/guides.module';
import { TeacherModule } from './modules/teacher/teacher.module';
import { GpaModule } from './modules/gpa/gpa.module';
import { ExecModule } from './modules/exec/exec.module';
import { DrawerModule } from './modules/drawer/drawer.module';
import { FilesModule } from './modules/files/files.module';
import { NotifyModule } from './modules/notify/notify.module';
import { ZoomModule } from './modules/zoom/zoom.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { GuardiansModule } from './modules/guardians/guardians.module';
import { StudentsModule } from './modules/students/students.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      // 키가 없으면 **부팅을 막는다.** 반쯤 뜬 서버가 가장 고치기 어렵다.
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().min(16).required(),
        JWT_REFRESH_SECRET: Joi.string().min(16).required(),
        JWT_EXPIRES: Joi.string().default('15m'),
        JWT_REFRESH_EXPIRES: Joi.string().default('14d'),
        PORT: Joi.number().default(3001),
        // 운영에서 기본 localhost를 넣으면 CORS 누락을 정상 설정처럼 숨긴다. 운영은 명시값 필수,
        // 개발·시험에서만 로컬 기본값을 쓴다.
        CORS_ORIGIN: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().trim().min(1).required(),
          otherwise: Joi.string().default('http://localhost:3000'),
        }),
        LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').default('info'),
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        /**
         * 공통 도메인 방식에서만 쓴다. same-origin proxy와 직접 cross-site는 빈 값이 정상이다.
         * CORS_ORIGIN을 실제로 덮는지와 세 모드의 상호 배타성은 `auth/cookie.ts` 의
         * `assertCookieConfig()`가 부팅 전에 확인한다.
         */
        COOKIE_DOMAIN: Joi.string().allow('').optional(),
        /**
         * 도메인 없이 `*.vercel.app` 두 개로 먼저 띄울 때만 'true'.
         * 값의 조합이 말이 되는지는 `auth/cookie.ts` 가 본다 — Joi 는 CORS_ORIGIN 과 대조할 수 없다.
         */
        COOKIE_CROSS_SITE: Joi.string().valid('true', 'false').default('false'),
        /**
         * 브라우저가 front의 같은-origin `/api/v1`만 부르고 Next가 이 API로 넘길 때 'true'.
         * COOKIE_DOMAIN/CROSS_SITE와의 충돌은 `auth/cookie.ts`가 부팅 전에 막는다.
         */
        COOKIE_SAME_ORIGIN_PROXY: Joi.string().valid('true', 'false').default('false'),
        ENABLE_DOCS: Joi.string().valid('true', 'false').default('false'),
        DB_POOL_MAX: Joi.number().optional(),
      }).unknown(true),
    }),
    TypeOrmModule.forRoot(dataSourceOptions),
    // 정기 작업 (D-R41) — 리포트 독촉 · 지각 차감 확정 · 정산 마감
    CronModule.forRoot(),
    AuthModule,
    // 화면이 읽는 것 — 코드표와 스케줄부터
    MetaModule,
    ScheduleModule,
    ReportsModule,
    AccountingModule,
    OpsModule,
    // 탭 04 · 05 · 06 · 07 · 11 — 내비게이션에 있는데 문이 없던 자리들
    ConsultingModule,
    BoardModule,
    BooksModule,
    GuidesModule,
    TeacherModule,
    GpaModule,
    ExecModule,
    // 탭 02 — 전역 우측 서랍. 다른 탭이 여기로 링크를 건다
    DrawerModule,
    // 올린 파일은 Neon 안에 둔다 (대표 결정 2026-09-12 · D6 · A-D4)
    FilesModule,
    // 바깥으로 나가는 발송 — 메일(SMTP)·문자(SENS). 키가 없으면 보낸 척하지 않는다
    NotifyModule,
    // §21 서랍의 「줌 계정 관리」가 가는 자리 — 대표 결정 2026-09-12 로 신설
    ZoomModule,
    // §18 서랍의 「프로그램·과목 전체 열기」가 가는 자리 — 같은 결정으로 신설
    CatalogModule,
    // 학생 보호자와 선택 발송 — DQ3 대표 답변 2026-09-25 (메일·SENS 만 · N-42)
    GuardiansModule,
    // UX-C1 학생 독립 목록·상세 — 기존 STU 읽기, 신규 등록/기간 이력은 별도 청크다.
    StudentsModule,
  ],
  controllers: [HealthController],
  providers: [
    // 순서가 중요하다 — 인증이 먼저 request.user 를 채워야 권한 가드가 판정할 수 있다
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 첫 설정 잠금(W8) — 인증 뒤 · 권한 앞. 권한 문장보다 「첫 설정」이라는 진짜 까닭을 먼저 말한다
    { provide: APP_GUARD, useClass: OnboardingGuard },
    { provide: APP_GUARD, useClass: PermGuard },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
})
export class AppModule {}
