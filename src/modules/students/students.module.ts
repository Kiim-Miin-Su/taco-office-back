/** @file-guide
 * 목적: students.module.ts — 학생 읽기 controller/service 연결
 * 책임/재사용: 기존 전역 TypeORM 연결을 사용한다. 스케줄·상담·보호자 writer를 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Module } from '@nestjs/common';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({ controllers: [StudentsController], providers: [StudentsService] })
export class StudentsModule {}
