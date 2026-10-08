/** @file-guide
 * 목적: 일반 자료요청의 담당 학생 검증, 상태 전이, 파일, 이력, 멱등과 알림을 원자적으로 처리한다.
 * 책임/재사용: GPAPACK과 분리된 MATREQ 원장이며 공용 FILE·권한·학생 표시 계약을 재사용한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · migration 1767900000000
 */

import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { todayKst } from '../../lib/kst';
import { NOTI_TITLE } from '../../lib/noti';
import { studentLabel, studentTagSql } from '../../lib/student-label';
import {
  prepareFile, storedFileRef, storePreparedFile, type PreparedFile,
} from '../files/files.service';
import type { FileUploadDto } from '../files/files.dto';
import type {
  MaterialRequestAcknowledgeDto, MaterialRequestCreateDto, MaterialRequestEventDto,
  MaterialRequestFileDto, MaterialRequestItemDto, MaterialRequestOptionsDto, MaterialRequestQueryDto,
  MaterialRequestsDto, MaterialRequestTransitionDto, MaterialRequestWriteResultDto,
} from './material-requests.dto';
import { MATERIAL_REQUEST_KIND_LABEL } from './material-requests.dto';

type Row = Record<string, unknown>;
type RequestAction = 'created' | 'preparing' | 'delivered' | 'rejected' | 'acknowledged';

const STATE_LABEL: Record<string, string> = {
  received: '접수', preparing: '준비 중', delivered: '전달 완료', rejected: '반려',
};
const ACTION_LABEL: Record<string, string> = {
  created: '요청 접수', preparing: '준비 시작', delivered: '자료 전달', rejected: '반려', acknowledged: '수신 확인',
};

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: unknown): string | null => value == null ? null : new Date(String(value)).toISOString();

@Injectable()
export class MaterialRequestsService {
  constructor(private readonly ds: DataSource) {}

  private assertTeacher(user: RequestUser): void {
    if (!isRole(user.role) || hasPerm(user.role, 'canAdminPage', user.perms)) {
      throw new ForbiddenException({ code: 'MATERIAL_REQUEST_TEACHER_ONLY', message: '강사 계정에서만 자료를 요청할 수 있습니다' });
    }
  }

  private assertAdmin(user: RequestUser): void {
    if (!isRole(user.role)
      || !hasPerm(user.role, 'canAdminPage', user.perms)
      || !hasPerm(user.role, 'canGpaPack', user.perms)) {
      throw new ForbiddenException({ code: 'MATERIAL_REQUEST_ADMIN_ONLY', message: '자료 요청을 처리할 권한이 없습니다' });
    }
  }

  private validateFiles(files: FileUploadDto[] | undefined): PreparedFile[] {
    return (files ?? []).map((file) => {
      if (file.kind !== 'material-request') {
        throw new BadRequestException({
          code: 'MATERIAL_REQUEST_FILE_KIND', message: '자료 요청 첨부는 material-request 종류여야 합니다',
        });
      }
      return prepareFile(file);
    });
  }

  private fileFingerprint(files: FileUploadDto[] | undefined, prepared: PreparedFile[]): unknown[] {
    return (files ?? []).map((file, index) => ({ name: file.name.trim(), sha256: prepared[index]!.sha256 }));
  }

  private async lockKey(m: EntityManager, requestKey: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('material-request'), hashtext($1))`, [requestKey]);
  }

  private async replay(
    m: EntityManager,
    requestKey: string,
    actorId: number,
    action: RequestAction,
    fingerprint: string,
  ): Promise<MaterialRequestWriteResultDto | null> {
    const [prior] = await m.query(`SELECT material_request_id,actor_id,action,payload_sha256,result_version
      FROM material_request_event WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    if (Number(prior.actor_id) !== actorId || String(prior.action) !== action || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({
        code: 'MATERIAL_REQUEST_KEY_REUSED', message: '같은 자료 요청 키를 다른 작업에 다시 사용할 수 없습니다',
      });
    }
    const item = await this.one(m, Number(prior.material_request_id));
    if (item.version !== Number(prior.result_version)) {
      throw new ConflictException({
        code: 'MATERIAL_REQUEST_REPLAY_STALE', message: '재시도한 요청 뒤에 상태가 변경되었습니다 — 최신 내역을 확인하세요',
      });
    }
    return { item, replayed: true };
  }

  private async assignedStudent(m: EntityManager | DataSource, teacherId: number, studentId: number): Promise<Row> {
    const [row] = await m.query(`SELECT s.id,s.name,s.grade,${studentTagSql('s')} AS tag
      FROM stu s WHERE s.id=$2 AND EXISTS (
        SELECT 1 FROM ser_stu ss JOIN ser se ON se.id=ss.ser_id
         WHERE ss.student_id=s.id AND se.teacher_id=$1
           AND (se.to_date IS NULL OR se.to_date >= $3::date)
           AND (ss.to_date IS NULL OR ss.to_date >= $3::date)
      )`, [teacherId, studentId, todayKst()]) as Row[];
    if (!row) {
      throw new NotFoundException({
        code: 'MATERIAL_REQUEST_STUDENT_NOT_ASSIGNED', message: '현재 또는 예정된 내 수업 학생만 선택할 수 있습니다',
      });
    }
    return row;
  }

  async options(user: RequestUser): Promise<MaterialRequestOptionsDto> {
    this.assertTeacher(user);
    const rows = await this.ds.query(`SELECT DISTINCT s.id,s.name,s.grade,${studentTagSql('s')} AS tag
      FROM stu s JOIN ser_stu ss ON ss.student_id=s.id JOIN ser se ON se.id=ss.ser_id
      WHERE se.teacher_id=$1 AND (se.to_date IS NULL OR se.to_date >= $2::date)
        AND (ss.to_date IS NULL OR ss.to_date >= $2::date)
      ORDER BY s.name,s.id`, [user.id, todayKst()]) as Row[];
    return {
      students: rows.map((row) => ({
        id: Number(row.id), name: String(row.name), grade: row.grade == null ? null : String(row.grade),
        label: studentLabel(String(row.name), row.tag == null ? null : String(row.tag)),
      })),
    };
  }

  async create(user: RequestUser, dto: MaterialRequestCreateDto): Promise<MaterialRequestWriteResultDto> {
    this.assertTeacher(user);
    if (dto.neededOn < todayKst()) {
      throw new BadRequestException({ code: 'MATERIAL_REQUEST_DATE_PAST', message: '필요일은 오늘 이후여야 합니다' });
    }
    const body = dto.body.trim();
    const prepared = this.validateFiles(dto.files);
    const fingerprint = sha({
      studentId: dto.studentId, kind: dto.kind, neededOn: dto.neededOn, body,
      files: this.fileFingerprint(dto.files, prepared),
    });
    return this.ds.transaction(async (m) => {
      await this.lockKey(m, dto.requestKey);
      const replay = await this.replay(m, dto.requestKey, user.id, 'created', fingerprint);
      if (replay) return replay;
      const student = await this.assignedStudent(m, user.id, dto.studentId);
      const [made] = await m.query(`INSERT INTO material_request
        (teacher_id,student_id,kind,needed_on,body,request_key)
        VALUES($1,$2,$3,$4::date,$5,$6) RETURNING id`,
      [user.id, dto.studentId, dto.kind, dto.neededOn, body, dto.requestKey]) as Row[];
      const requestId = Number(made.id);
      const [event] = await m.query(`INSERT INTO material_request_event
        (material_request_id,action,from_state,to_state,actor_id,request_key,payload_sha256,result_version)
        VALUES($1,'created',NULL,'received',$2,$3,$4,1) RETURNING id`,
      [requestId, user.id, dto.requestKey, fingerprint]) as Row[];
      await this.saveFiles(m, requestId, Number(event.id), user.id, 'request', dto.files, prepared);
      await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category)
        SELECT a.id,$1,$2,$3,$4,'request' FROM staff a
         WHERE a.active AND a.role <> 'teacher' AND COALESCE(a.can_gpa_pack,TRUE)
        ORDER BY a.id`, [
        user.id, NOTI_TITLE.materialRequestReceived,
        `${student.name} · ${MATERIAL_REQUEST_KIND_LABEL[dto.kind]} · 필요 ${dto.neededOn}`,
        `/books?tab=requests&request=${requestId}`,
      ]);
      return { item: await this.one(m, requestId), replayed: false };
    });
  }

  private async saveFiles(
    m: EntityManager,
    requestId: number,
    eventId: number,
    actorId: number,
    purpose: 'request' | 'delivery',
    files: FileUploadDto[] | undefined,
    prepared: PreparedFile[],
  ): Promise<void> {
    for (let index = 0; index < (files ?? []).length; index += 1) {
      const file = files![index]!;
      const stored = await storePreparedFile(m, actorId, file, prepared[index]!);
      await m.query(`INSERT INTO material_request_file(material_request_id,event_id,file_id,purpose,added_by)
        VALUES($1,$2,$3,$4,$5)`, [requestId, eventId, stored.id, purpose, actorId]);
    }
  }

  async transition(user: RequestUser, id: number, dto: MaterialRequestTransitionDto): Promise<MaterialRequestWriteResultDto> {
    this.assertAdmin(user);
    const reason = dto.reason?.trim() || null;
    const prepared = this.validateFiles(dto.files);
    if (dto.action === 'preparing' && ((dto.files?.length ?? 0) > 0 || reason)) {
      throw new BadRequestException({ code: 'MATERIAL_REQUEST_PREPARING_SHAPE', message: '준비 시작에는 파일이나 반려 사유를 넣지 않습니다' });
    }
    if (dto.action === 'delivered' && prepared.length < 1) {
      throw new BadRequestException({ code: 'MATERIAL_REQUEST_DELIVERY_FILE_REQUIRED', message: '전달 완료에는 실제 자료 파일이 필요합니다' });
    }
    if (dto.action === 'delivered' && reason) {
      throw new BadRequestException({ code: 'MATERIAL_REQUEST_DELIVERY_REASON', message: '전달 완료에는 반려 사유를 넣지 않습니다' });
    }
    if (dto.action === 'rejected' && (!reason || reason.length < 2)) {
      throw new BadRequestException({ code: 'MATERIAL_REQUEST_REJECT_REASON_REQUIRED', message: '반려 사유를 두 글자 이상 입력해 주세요' });
    }
    if (dto.action === 'rejected' && prepared.length > 0) {
      throw new BadRequestException({ code: 'MATERIAL_REQUEST_REJECT_FILE', message: '반려할 때 전달 파일을 올릴 수 없습니다' });
    }
    const fingerprint = sha({
      id, action: dto.action, expectedVersion: dto.expectedVersion, reason,
      files: this.fileFingerprint(dto.files, prepared),
    });
    return this.ds.transaction(async (m) => {
      await this.lockKey(m, dto.requestKey);
      const replay = await this.replay(m, dto.requestKey, user.id, dto.action, fingerprint);
      if (replay) return replay;
      const [current] = await m.query(`SELECT * FROM material_request WHERE id=$1 FOR UPDATE`, [id]) as Row[];
      if (!current) throw new NotFoundException({ code: 'MATERIAL_REQUEST_NOT_FOUND', message: '자료 요청을 찾을 수 없습니다' });
      if (Number(current.row_version) !== dto.expectedVersion) {
        throw new ConflictException({ code: 'MATERIAL_REQUEST_STALE', message: '다른 처리 결과가 있습니다 — 목록을 새로고침해 주세요' });
      }
      const fromState = String(current.state);
      const valid = dto.action === 'preparing'
        ? fromState === 'received'
        : dto.action === 'delivered'
          ? fromState === 'preparing'
          : fromState === 'received' || fromState === 'preparing';
      if (!valid) {
        throw new ConflictException({
          code: 'MATERIAL_REQUEST_INVALID_TRANSITION', message: `${STATE_LABEL[fromState]} 상태에서는 이 처리를 할 수 없습니다`,
        });
      }
      const nextVersion = dto.expectedVersion + 1;
      const assignedTo = dto.action === 'preparing' ? user.id : current.assigned_to;
      const deliveredBy = dto.action === 'delivered' ? user.id : null;
      const [changedRows] = await m.query(`UPDATE material_request SET state=$2::varchar(16),row_version=$3,
          assigned_to=$4,delivered_by=$5,reject_reason=$6,
          delivered_at=CASE WHEN $2::text='delivered' THEN now() ELSE NULL END,
          rejected_at=CASE WHEN $2::text='rejected' THEN now() ELSE NULL END,updated_at=now()
        WHERE id=$1 AND row_version=$7 RETURNING id`,
      [id, dto.action, nextVersion, assignedTo, deliveredBy, reason, dto.expectedVersion]) as [Row[], number];
      if (!changedRows[0]) {
        throw new ConflictException({ code: 'MATERIAL_REQUEST_STALE', message: '다른 처리 결과가 있습니다 — 목록을 새로고침해 주세요' });
      }
      const [event] = await m.query(`INSERT INTO material_request_event
        (material_request_id,action,from_state,to_state,reason,actor_id,request_key,payload_sha256,result_version)
        VALUES($1,$2::varchar(20),$3,$2::varchar(16),$4,$5,$6,$7,$8) RETURNING id`,
      [id, dto.action, fromState, reason, user.id, dto.requestKey, fingerprint, nextVersion]) as Row[];
      if (dto.action === 'delivered') {
        await this.saveFiles(m, id, Number(event.id), user.id, 'delivery', dto.files, prepared);
      }
      const title = dto.action === 'preparing'
        ? NOTI_TITLE.materialRequestPreparing
        : dto.action === 'delivered'
          ? NOTI_TITLE.materialRequestDelivered
          : NOTI_TITLE.materialRequestRejected;
      const body = dto.action === 'rejected'
        ? `자료 요청이 반려됐습니다 · ${reason}`
        : dto.action === 'delivered'
          ? '요청한 자료가 내부 파일로 도착했습니다 · 수신 확인해 주세요'
          : '자료 요청 준비를 시작했습니다';
      await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category)
        VALUES($1,$2,$3,$4,$5,'request')`, [
        current.teacher_id, user.id, title, body, `/teacher/guides?request=${id}`,
      ]);
      return { item: await this.one(m, id), replayed: false };
    });
  }

  async acknowledge(user: RequestUser, id: number, dto: MaterialRequestAcknowledgeDto): Promise<MaterialRequestWriteResultDto> {
    this.assertTeacher(user);
    const fingerprint = sha({ id, expectedVersion: dto.expectedVersion });
    return this.ds.transaction(async (m) => {
      await this.lockKey(m, dto.requestKey);
      const replay = await this.replay(m, dto.requestKey, user.id, 'acknowledged', fingerprint);
      if (replay) return replay;
      const [current] = await m.query(`SELECT * FROM material_request WHERE id=$1 FOR UPDATE`, [id]) as Row[];
      if (!current || Number(current.teacher_id) !== user.id) {
        throw new NotFoundException({ code: 'MATERIAL_REQUEST_NOT_FOUND', message: '내 자료 요청을 찾을 수 없습니다' });
      }
      if (Number(current.row_version) !== dto.expectedVersion) {
        throw new ConflictException({ code: 'MATERIAL_REQUEST_STALE', message: '다른 처리 결과가 있습니다 — 목록을 새로고침해 주세요' });
      }
      if (String(current.state) !== 'delivered') {
        throw new ConflictException({ code: 'MATERIAL_REQUEST_NOT_DELIVERED', message: '전달 완료된 자료만 수신 확인할 수 있습니다' });
      }
      if (current.acknowledged_at != null) {
        throw new ConflictException({ code: 'MATERIAL_REQUEST_ALREADY_ACKNOWLEDGED', message: '이미 수신 확인한 자료입니다' });
      }
      const nextVersion = dto.expectedVersion + 1;
      const [changedRows] = await m.query(`UPDATE material_request
        SET acknowledged_at=now(),row_version=$2,updated_at=now()
        WHERE id=$1 AND row_version=$3 RETURNING id`, [id, nextVersion, dto.expectedVersion]) as [Row[], number];
      if (!changedRows[0]) {
        throw new ConflictException({ code: 'MATERIAL_REQUEST_STALE', message: '다른 처리 결과가 있습니다 — 목록을 새로고침해 주세요' });
      }
      await m.query(`INSERT INTO material_request_event
        (material_request_id,action,from_state,to_state,actor_id,request_key,payload_sha256,result_version)
        VALUES($1,'acknowledged','delivered','delivered',$2,$3,$4,$5)`,
      [id, user.id, dto.requestKey, fingerprint, nextVersion]);
      if (current.assigned_to != null) {
        await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category)
          VALUES($1,$2,$3,'강사가 전달 자료를 확인했습니다',$4,'request')`, [
          current.assigned_to, user.id, NOTI_TITLE.materialRequestAcknowledged,
          `/books?tab=requests&request=${id}`,
        ]);
      }
      return { item: await this.one(m, id), replayed: false };
    });
  }

  async mine(user: RequestUser): Promise<MaterialRequestsDto> {
    this.assertTeacher(user);
    return this.list(`WHERE r.teacher_id=$1`, [user.id], 100);
  }

  async all(user: RequestUser, query: MaterialRequestQueryDto): Promise<MaterialRequestsDto> {
    this.assertAdmin(user);
    return query.state
      ? this.list(`WHERE r.state=$1`, [query.state], 200)
      : this.list('', [], 200);
  }

  private async list(where: string, params: unknown[], limit: number): Promise<MaterialRequestsDto> {
    const rows = await this.ds.query(`${this.baseSelect()} ${where}
      ORDER BY CASE r.state WHEN 'received' THEN 0 WHEN 'preparing' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END,
        r.needed_on,r.id DESC LIMIT ${limit}`, params) as Row[];
    const items = await this.attach(this.ds, rows);
    const counts = { received: 0, preparing: 0, delivered: 0, rejected: 0 };
    items.forEach((item) => { counts[item.state as keyof typeof counts] += 1; });
    return { items, counts };
  }

  private async one(m: EntityManager | DataSource, id: number): Promise<MaterialRequestItemDto> {
    const [row] = await m.query(`${this.baseSelect()} WHERE r.id=$1`, [id]) as Row[];
    if (!row) throw new NotFoundException({ code: 'MATERIAL_REQUEST_NOT_FOUND', message: '자료 요청을 찾을 수 없습니다' });
    return (await this.attach(m, [row]))[0]!;
  }

  private baseSelect(): string {
    return `SELECT r.id,r.kind,r.student_id,s.name AS student_name,r.teacher_id,t.name AS teacher_name,
      r.needed_on::text,r.body,r.state,r.row_version,r.assigned_to,a.name AS assigned_to_name,
      r.delivered_by,d.name AS delivered_by_name,r.reject_reason,r.delivered_at,r.rejected_at,
      r.acknowledged_at,r.created_at,r.updated_at
      FROM material_request r JOIN stu s ON s.id=r.student_id JOIN staff t ON t.id=r.teacher_id
      LEFT JOIN staff a ON a.id=r.assigned_to LEFT JOIN staff d ON d.id=r.delivered_by`;
  }

  private async attach(m: EntityManager | DataSource, rows: Row[]): Promise<MaterialRequestItemDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => Number(row.id));
    const [files, events] = await Promise.all([
      m.query(`SELECT l.material_request_id,l.purpose,a.name AS added_by_name,
          f.id AS file_id,f.kind AS file_kind,f.name AS file_name,f.mime AS file_mime,
          f.bytes AS file_bytes,u.name AS file_uploader_name,f.uploaded_at AS file_uploaded_at
        FROM material_request_file l JOIN file f ON f.id=l.file_id JOIN staff a ON a.id=l.added_by
        LEFT JOIN staff u ON u.id=f.uploaded_by WHERE l.material_request_id=ANY($1::bigint[])
        ORDER BY l.id`, [ids]) as Promise<Row[]>,
      m.query(`SELECT e.material_request_id,e.id,e.action,e.from_state,e.to_state,e.reason,e.actor_id,
          a.name AS actor_name,e.result_version,e.created_at
        FROM material_request_event e JOIN staff a ON a.id=e.actor_id
        WHERE e.material_request_id=ANY($1::bigint[]) ORDER BY e.result_version,e.id`, [ids]) as Promise<Row[]>,
    ]);
    return rows.map((row) => {
      const id = Number(row.id);
      const itemFiles = files.filter((file) => Number(file.material_request_id) === id).flatMap((file) => {
        const ref = storedFileRef(file);
        if (!ref) return [];
        return [{ ...ref, purpose: String(file.purpose), addedByName: String(file.added_by_name) } as MaterialRequestFileDto];
      });
      const itemEvents = events.filter((event) => Number(event.material_request_id) === id).map((event): MaterialRequestEventDto => ({
        id: Number(event.id), action: String(event.action), actionLabel: ACTION_LABEL[String(event.action)] ?? String(event.action),
        fromState: event.from_state == null ? null : String(event.from_state), toState: String(event.to_state),
        reason: event.reason == null ? null : String(event.reason), actorId: Number(event.actor_id), actorName: String(event.actor_name),
        resultVersion: Number(event.result_version), at: new Date(String(event.created_at)).toISOString(),
      }));
      const state = String(row.state);
      return {
        id, kind: String(row.kind),
        kindLabel: MATERIAL_REQUEST_KIND_LABEL[String(row.kind) as keyof typeof MATERIAL_REQUEST_KIND_LABEL] ?? String(row.kind),
        studentId: Number(row.student_id), studentName: String(row.student_name),
        teacherId: Number(row.teacher_id), teacherName: String(row.teacher_name),
        neededOn: String(row.needed_on), body: String(row.body), state, stateLabel: STATE_LABEL[state] ?? state,
        version: Number(row.row_version), assignedTo: row.assigned_to == null ? null : Number(row.assigned_to),
        assignedToName: row.assigned_to_name == null ? null : String(row.assigned_to_name),
        deliveredBy: row.delivered_by == null ? null : Number(row.delivered_by),
        deliveredByName: row.delivered_by_name == null ? null : String(row.delivered_by_name),
        rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
        deliveredAt: iso(row.delivered_at), rejectedAt: iso(row.rejected_at), acknowledgedAt: iso(row.acknowledged_at),
        createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
        overdue: (state === 'received' || state === 'preparing') && String(row.needed_on) < todayKst(),
        files: itemFiles, events: itemEvents,
      };
    });
  }
}
