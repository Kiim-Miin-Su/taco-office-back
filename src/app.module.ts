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
import { ExecModule } from './modules/exec/exec.module';
import { DrawerModule } from './modules/drawer/drawer.module';

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
        CORS_ORIGIN: Joi.string().default('http://localhost:3000'),
        LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').default('info'),
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
    ExecModule,
    // 탭 02 — 전역 우측 서랍. 다른 탭이 여기로 링크를 건다
    DrawerModule,
  ],
  controllers: [HealthController],
  providers: [
    // 순서가 중요하다 — 인증이 먼저 request.user 를 채워야 권한 가드가 판정할 수 있다
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermGuard },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
})
export class AppModule {}
