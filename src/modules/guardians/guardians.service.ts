/** @file-guide
 * 목적: guardians.service.ts — GuardiansService (service)
 * 책임/재사용: 보호자 쓰기와 선택 발송을 트랜잭션으로 소유한다. 발송은 notify/SENDER 경계만 부르고 결과를 보호자×채널 원장에 남긴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보호자 — DQ3 대표 답변 (2026-09-25 · N-42): 「복수 보호자 + 선택 발송을 하되 현재 사용되는 이메일과 Naver SENS 만 이용」.
 *
 * **지우지 않는다.** 「삭제」는 `active=false` 다 — `guardian_send` 원장이 그 보호자를 가리키고, 누구에게 무엇이
 * 나갔는지는 보호자를 바꾼 뒤에도 참이어야 한다.
 *
 * **보낸 척하지 않는다.** 채널 설정이 없으면(`sender.ready=false`) 시도하지 않고 `not_configured` 로 원장에 남긴다.
 * PNOTI(§43 회차 학부모 안내)의 `sent_at` 은 **실제로 나간 줄(`sent`)이 하나라도 있을 때만** 찍는다 — 전에는
 * 수신처가 없어 그 줄이 영원히 「보낼 것」이었다.
 *
 * **연락처는 로그에 가지 않는다.** 원장에는 가린 받는 곳(`to_masked`)만, LOG 에는 가린 모양만 적는다. 공급자
 * 오류 문장도 `scrubContact` 로 가린 뒤에 적는다.
 *
 * 발송은 한 트랜잭션 안에서 `requestKey` 권고 잠금을 쥐고 한다 — 같은 키의 두 요청이 동시에 와도 둘째는 첫째의
 * 원장을 돌려받는다(더블클릭·재시도가 두 번 보내지 않는다). 대가: 외부 발송이 끝날 때까지 연결 하나를 쥔다.
 * 발송 뒤 커밋이 실패하면 나간 메시지의 원장이 사라질 수 있다 — 그 창은 INSERT 몇 줄뿐이라 좁게 둔다.
 */
import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { kstAt, writtenRows } from '../../lib/sql';
import {
  CHANNEL_SPECS, SEND_CHANNELS, SEND_TIMEOUT_MS, SENDER, phoneDigits, scrubContact,
  type SendChannel, type Sender, type SendResult,
} from '../notify/sender';
import type {
  GuardianChannelsDto, GuardianCreateDto, GuardianDto, GuardianListDto, GuardianPatchDto,
  GuardianSendDto, GuardianSendItemDto, GuardianSendResultDto, GuardianSendSkipDto,
} from './guardians.dto';

interface GuardianRow {
  id: string;
  student_id: string;
  name: string;
  relation: string | null;
  email: string | null;
  phone: string | null;
  receive_email: boolean;
  receive_sms: boolean;
  is_primary: boolean;
  active: boolean;
  created_at: string;
}

interface LedgerRow {
  id: string;
  request_key: string;
  pnoti_id: string | null;
  student_id: string;
  guardian_id: string;
  guardian_name: string;
  relation: string | null;
  channel: SendChannel;
  to_masked: string;
  status: SendStatus;
  error: string | null;
  sent_at: string;
}

type SendStatus = 'sent' | 'failed' | 'not_configured';

/**
 * 한 요청이 공급자를 부르는 상한 — 보호자 × 채널 중 **설정이 있어 실제로 부르는 것만** 센다.
 * 넷씩 나란히 보내고 한 곳은 {@link DELIVER_CAP_MS} 안에 끝내므로 최악이 두 차례 ≈ 20초 — 서버리스 30초 안이다.
 * 넘기면 원장을 쓰기 전에 거절한다(보안 검토 0925 #1 — 함수가 끊기면 이미 나간 메시지의 원장이 사라지고 재시도가 다시 보낸다).
 */
export const MAX_SEND_ATTEMPTS = 8;
const SEND_CONCURRENCY = 4;
/** 공급자 자체 제한 시간 위에 한 번 더 — 단계별 시간 제한을 합치면 한 통이 더 길어질 수 있다 */
const DELIVER_CAP_MS = SEND_TIMEOUT_MS + 2_000;
const DELIVER_TIMEOUT_ERROR = '공급자 응답이 제한 시간을 넘었습니다 — 실제로 도착했는지 확인이 필요합니다';

/**
 * **채널 추가 자리 ④** — 보호자가 그 채널을 받는가 · 어디로 보내는가.
 * `Record<SendChannel, …>` 라서 `notify/sender.SEND_CHANNELS` 에 채널을 더하면 여기가 비어 컴파일이 멈춘다 —
 * 그때 보호자 표에 `receive_<채널>` 과 연락처 칸을 함께 새긴다(마이그레이션 · erd.dbml).
 */
const RECEIVES: Record<SendChannel, {
  accepts(g: GuardianRow): boolean;
  contact(g: GuardianRow): string | null;
  /** 받지 않는 채널을 골랐을 때 건너뛰는 까닭 */
  notAccepted: string;
  /** 받는다고 켰는데 연락처가 없을 때 */
  missingContact: string;
}> = {
  email: {
    accepts: (g) => g.receive_email && g.email !== null,
    contact: (g) => g.email,
    notAccepted: '메일을 받지 않는 보호자입니다',
    missingContact: '메일을 받으려면 메일 주소가 있어야 합니다',
  },
  sms: {
    accepts: (g) => g.receive_sms && g.phone !== null,
    contact: (g) => g.phone,
    notAccepted: '문자를 받지 않는 보호자입니다',
    missingContact: '문자를 받으려면 휴대폰 번호가 있어야 합니다',
  },
};

/** 결과 낱말 — 화면은 이 말을 그대로 그린다 (「설정 없음 — 보내지 않았습니다」) */
const STATUS_LABEL: Record<SendStatus, string> = {
  sent: '보냈습니다',
  failed: '보내지 못했습니다',
  not_configured: '설정 없음 — 보내지 않았습니다',
};

const GUARDIAN_COLS = `id, student_id, name, relation, email, phone, receive_email, receive_sms, is_primary, active,
  ${kstAt('created_at')} AS created_at`;

@Injectable()
export class GuardiansService {
  constructor(
    private readonly ds: DataSource,
    @Inject(SENDER) private readonly sender: Sender,
  ) {}

  /** 지금 보낼 수 있는 채널 — 설정이 없으면 까닭과 함께 잠긴다 */
  channels(): GuardianChannelsDto {
    return {
      channels: SEND_CHANNELS.map((channel) => {
        const ready = this.sender.ready(channel);
        return {
          channel,
          label: CHANNEL_SPECS[channel].label,
          ready,
          reason: ready ? null : CHANNEL_SPECS[channel].notReadyReason,
        };
      }),
    };
  }

  async list(studentId: number): Promise<GuardianListDto> {
    const student = await this.student(this.ds, studentId);
    const rows = await this.ds.query(
      `SELECT ${GUARDIAN_COLS} FROM guardian WHERE student_id = $1
        ORDER BY active DESC, is_primary DESC, name, id`,
      [studentId],
    ) as GuardianRow[];
    return { studentId, studentName: student.name, guardians: rows.map(toDto) };
  }

  async create(studentId: number, dto: GuardianCreateDto, actorId: number): Promise<GuardianDto> {
    return this.tx(async (q) => {
      // 학생 줄을 잡아 대표 보호자 바꾸기를 학생 단위로 줄 세운다 (부분 유니크가 마지막에 막는다)
      await this.student(q, studentId, true);
      const email = dto.email ?? null;
      const phone = dto.phone ? phoneDigits(dto.phone) : null;
      const receiveEmail = dto.receiveEmail ?? email !== null;
      const receiveSms = dto.receiveSms ?? false;
      assertContacts({ email, phone, receiveEmail, receiveSms });
      // 대표를 따로 고르지 않았으면 첫 보호자가 대표가 된다 — 발송 창이 미리 체크할 사람이 없으면 매번 고르게 된다
      const isPrimary = dto.isPrimary ?? !(await this.hasPrimary(q, studentId));
      if (isPrimary) await this.demotePrimary(q, studentId);
      const [row] = await q.query(
        `INSERT INTO guardian (student_id, name, relation, email, phone, receive_email, receive_sms, is_primary, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${GUARDIAN_COLS}`,
        [studentId, dto.name, dto.relation ?? null, email, phone, receiveEmail, receiveSms, isPrimary, actorId],
      ) as GuardianRow[];
      await this.log(q, actorId, 'GUARDIAN', Number(row.id), 'create', null, snapshot(row));
      return toDto(row);
    });
  }

  async patch(id: number, dto: GuardianPatchDto, actorId: number): Promise<GuardianDto> {
    return this.tx(async (q) => {
      const before = await this.lockGuardian(q, id);
      if (!before.active && dto.active !== true) {
        throw new ConflictException({ code: 'GUARDIAN_INACTIVE', message: '사용 중지한 보호자입니다 — 다시 쓰기부터 해 주세요' });
      }
      const email = dto.email === undefined ? before.email : dto.email;
      const phone = dto.phone === undefined ? before.phone : dto.phone === null ? null : phoneDigits(dto.phone);
      // 연락처를 비우면 그 채널 받기도 함께 꺼진다 — 따로 끄라고 되묻지 않는다
      const receiveEmail = dto.receiveEmail ?? (before.receive_email && email !== null);
      const receiveSms = dto.receiveSms ?? (before.receive_sms && phone !== null);
      assertContacts({ email, phone, receiveEmail, receiveSms });
      const isPrimary = dto.isPrimary ?? before.is_primary;
      if (isPrimary && !before.is_primary) await this.demotePrimary(q, Number(before.student_id));
      const [after] = writtenRows<GuardianRow>(await q.query(
        `UPDATE guardian
            SET name = $2, relation = $3, email = $4, phone = $5, receive_email = $6, receive_sms = $7,
                is_primary = $8, active = true
          WHERE id = $1
          RETURNING ${GUARDIAN_COLS}`,
        [id, dto.name ?? before.name, dto.relation === undefined ? before.relation : dto.relation,
          email, phone, receiveEmail, receiveSms, isPrimary],
      ));
      await this.log(q, actorId, 'GUARDIAN', id, before.active ? 'update' : 'reactivate', snapshot(before), snapshot(after));
      return toDto(after);
    });
  }

  /** 「삭제」 — 지우지 않고 사용 중지한다. 대표였으면 대표도 내려간다(새 대표는 사람이 고른다) */
  async deactivate(id: number, actorId: number): Promise<GuardianDto> {
    return this.tx(async (q) => {
      const before = await this.lockGuardian(q, id);
      if (!before.active) return toDto(before);
      const [after] = writtenRows<GuardianRow>(await q.query(
        `UPDATE guardian SET active = false, is_primary = false WHERE id = $1 RETURNING ${GUARDIAN_COLS}`,
        [id],
      ));
      await this.log(q, actorId, 'GUARDIAN', id, 'deactivate', snapshot(before), snapshot(after));
      return toDto(after);
    });
  }

  /**
   * 선택 발송 — 고른 보호자 × 고른 채널마다 SENDER 를 한 번 부르고 원장에 한 줄을 남긴다.
   * 서버가 다시 본다: 그 학생의 보호자인가 · 사용 중인가 · 그 채널을 받는가 · PNOTI 가 그 학생의 학부모 줄인가.
   */
  async send(dto: GuardianSendDto, actorId: number): Promise<GuardianSendResultDto> {
    return this.tx(async (q) => {
      // 같은 키의 동시 요청을 줄 세운다 — 둘째는 첫째가 남긴 원장을 돌려받는다
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [dto.requestKey]);
      const prior = await this.ledger(q, dto.requestKey);
      if (prior.length > 0) {
        if (prior.some((r) => Number(r.student_id) !== dto.studentId)) {
          throw new ConflictException({ code: 'REQUEST_KEY_REUSED', message: '이미 다른 학생에게 쓴 요청 키입니다 — 창을 닫고 다시 보내 주세요' });
        }
        const pnotiId = prior[0].pnoti_id === null ? null : Number(prior[0].pnoti_id);
        return this.result(q, dto.requestKey, dto.studentId, pnotiId, prior, [], true);
      }

      const student = await this.student(q, dto.studentId);
      const pnotiId = dto.pnotiId ?? null;
      if (pnotiId !== null) await this.assertParentNotice(q, pnotiId, dto.studentId);

      const rows = await q.query(
        `SELECT ${GUARDIAN_COLS} FROM guardian WHERE id = ANY($1::bigint[]) AND student_id = $2 FOR SHARE`,
        [dto.guardianIds, dto.studentId],
      ) as GuardianRow[];
      if (rows.length !== dto.guardianIds.length) {
        throw new BadRequestException({ code: 'GUARDIAN_NOT_OF_STUDENT', message: '이 학생의 보호자가 아닌 사람이 섞여 있습니다' });
      }
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      const guardians = dto.guardianIds.map((gid) => byId.get(gid)!);
      const inactive = guardians.find((g) => !g.active);
      if (inactive) {
        throw new BadRequestException({ code: 'GUARDIAN_INACTIVE', message: `${inactive.name} 님은 사용 중지한 보호자입니다` });
      }

      // 채널 순서는 서버 배열 순서다 — 화면이 보낸 순서에 따라 원장 줄 순서가 달라지지 않게
      const channels = SEND_CHANNELS.filter((c) => dto.channels.includes(c));
      const pairs: Array<{ g: GuardianRow; channel: SendChannel; to: string }> = [];
      const skipped: GuardianSendSkipDto[] = [];
      for (const g of guardians) {
        const mine = channels.filter((c) => RECEIVES[c].accepts(g));
        if (mine.length === 0) {
          throw new BadRequestException({ code: 'GUARDIAN_CHANNEL_MISMATCH', message: `${g.name} 님은 고른 채널로 받지 않습니다` });
        }
        for (const channel of channels) {
          if (mine.includes(channel)) pairs.push({ g, channel, to: RECEIVES[channel].contact(g)! });
          else skipped.push({ guardianId: Number(g.id), guardianName: g.name, channel, channelLabel: CHANNEL_SPECS[channel].label, reason: RECEIVES[channel].notAccepted });
        }
      }

      const attempts = pairs.filter((p) => this.sender.ready(p.channel)).length;
      if (attempts > MAX_SEND_ATTEMPTS) {
        throw new BadRequestException({
          code: 'GUARDIAN_SEND_TOO_MANY',
          message: `한 번에 보낼 수 있는 곳은 ${MAX_SEND_ATTEMPTS}곳(보호자 × 채널)까지입니다 — 지금 ${attempts}곳이라 나눠서 보내 주세요`,
        });
      }

      const subject = dto.subject ?? `${student.name} 학생 안내`;
      // 넷씩 나란히 부르고, 원장 줄은 고른 순서 그대로 적는다
      const results: SendResult[] = [];
      for (let i = 0; i < pairs.length; i += SEND_CONCURRENCY) {
        const batch = pairs.slice(i, i + SEND_CONCURRENCY);
        results.push(...await Promise.all(batch.map((p) => this.deliver(p.channel, p.to, subject, dto.body))));
      }
      for (const [i, { g, channel, to }] of pairs.entries()) {
        const res = results[i];
        const status: SendStatus = !res.configured ? 'not_configured' : res.ok ? 'sent' : 'failed';
        const error = res.error ? scrubContact(res.error, channel, to).slice(0, 500) : null;
        await q.query(
          `INSERT INTO guardian_send (request_key, pnoti_id, student_id, guardian_id, channel, to_masked, status, provider_id, error, sent_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [dto.requestKey, pnotiId, dto.studentId, Number(g.id), channel, CHANNEL_SPECS[channel].mask(to),
            status, res.providerId?.slice(0, 200) ?? null, error, actorId],
        );
      }

      const saved = await this.ledger(q, dto.requestKey);
      const firstSent = saved.find((r) => r.status === 'sent');
      // 실제로 나간 것이 있을 때만 안내 줄을 「보냄」으로 — 설정 없음·실패만 있으면 그대로 「보낼 것」이다
      if (pnotiId !== null && firstSent) {
        await q.query(
          `UPDATE pnoti SET sent_at = now(), channel = $2 WHERE id = $1 AND sent_at IS NULL`,
          [pnotiId, firstSent.channel],
        );
      }
      await this.log(q, actorId, 'GUARDIAN_SEND', Number(saved[0].id), 'send', null, {
        requestKey: dto.requestKey, studentId: dto.studentId, pnotiId,
        guardianIds: dto.guardianIds, channels, counts: counts(saved, skipped.length),
      });
      return this.result(q, dto.requestKey, dto.studentId, pnotiId, saved, skipped, false);
    });
  }

  /** 설정이 없으면 부르지도 않는다. 발송기가 던져도 원장에는 「실패」로 남긴다 — 한 사람 실패로 나머지를 멈추지 않는다 */
  private async deliver(channel: SendChannel, to: string, subject: string, body: string): Promise<SendResult> {
    if (!this.sender.ready(channel)) {
      return { configured: false, ok: false, providerId: null, error: CHANNEL_SPECS[channel].notReadyReason };
    }
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<SendResult>((resolve) => {
      timer = setTimeout(() => resolve({ configured: true, ok: false, providerId: null, error: DELIVER_TIMEOUT_ERROR }), DELIVER_CAP_MS);
    });
    try {
      return await Promise.race([this.sender.send({ channel, to, subject, body }), cap]);
    } catch (e) {
      return { configured: true, ok: false, providerId: null, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async result(
    q: QueryRunner, requestKey: string, studentId: number, pnotiId: number | null,
    rows: LedgerRow[], skipped: GuardianSendSkipDto[], replayed: boolean,
  ): Promise<GuardianSendResultDto> {
    let pnotiSentAt: string | null = null;
    if (pnotiId !== null) {
      const [p] = await q.query(`SELECT ${kstAt('sent_at')} AS sent_at FROM pnoti WHERE id = $1`, [pnotiId]) as Array<{ sent_at: string | null }>;
      pnotiSentAt = p?.sent_at ?? null;
    }
    const c = counts(rows, skipped.length);
    return {
      requestKey, studentId, pnotiId, replayed, pnotiSentAt,
      summary: summary(c),
      counts: c,
      items: rows.map((r): GuardianSendItemDto => ({
        guardianId: Number(r.guardian_id), guardianName: r.guardian_name, relation: r.relation,
        channel: r.channel, channelLabel: CHANNEL_SPECS[r.channel]?.label ?? r.channel,
        toMasked: r.to_masked, status: r.status, statusLabel: STATUS_LABEL[r.status],
        error: r.error, sentAt: r.sent_at,
      })),
      skipped,
    };
  }

  private async ledger(q: QueryRunner, requestKey: string): Promise<LedgerRow[]> {
    return q.query(
      `SELECT s.id, s.request_key, s.pnoti_id, s.student_id, s.guardian_id, g.name AS guardian_name, g.relation,
              s.channel, s.to_masked, s.status, s.error, ${kstAt('s.sent_at')} AS sent_at
         FROM guardian_send s JOIN guardian g ON g.id = s.guardian_id
        WHERE s.request_key = $1
        ORDER BY s.id`,
      [requestKey],
    ) as Promise<LedgerRow[]>;
  }

  /** PNOTI 는 **그 학생의 학부모 줄**이어야 한다 — 남의 안내 줄을 「보냄」으로 바꾸지 않는다 */
  private async assertParentNotice(q: QueryRunner, pnotiId: number, studentId: number): Promise<void> {
    const [p] = await q.query(
      `SELECT id, student_id, audience::text AS audience FROM pnoti WHERE id = $1 FOR UPDATE`,
      [pnotiId],
    ) as Array<{ id: string; student_id: string | null; audience: string }>;
    if (!p || p.audience !== 'parent' || Number(p.student_id) !== studentId) {
      throw new BadRequestException({ code: 'PNOTI_NOT_OF_STUDENT', message: '이 학생의 학부모 안내가 아닙니다' });
    }
  }

  private async student(q: DataSource | QueryRunner, studentId: number, lock = false): Promise<{ id: number; name: string }> {
    const [row] = await q.query(
      `SELECT id, name FROM stu WHERE id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
      [studentId],
    ) as Array<{ id: string; name: string }>;
    if (!row) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생이 없습니다' });
    return { id: Number(row.id), name: row.name };
  }

  /** 보호자 한 명을 잡는다 — 학생 줄을 먼저 잡아 대표 바꾸기와 같은 순서로 줄 선다 */
  private async lockGuardian(q: QueryRunner, id: number): Promise<GuardianRow> {
    const [head] = await q.query(`SELECT student_id FROM guardian WHERE id = $1`, [id]) as Array<{ student_id: string }>;
    if (!head) throw new NotFoundException({ code: 'GUARDIAN_NOT_FOUND', message: '보호자가 없습니다' });
    await this.student(q, Number(head.student_id), true);
    const [row] = await q.query(`SELECT ${GUARDIAN_COLS} FROM guardian WHERE id = $1 FOR UPDATE`, [id]) as GuardianRow[];
    return row;
  }

  private async hasPrimary(q: QueryRunner, studentId: number): Promise<boolean> {
    const rows = await q.query(`SELECT 1 FROM guardian WHERE student_id = $1 AND is_primary`, [studentId]) as unknown[];
    return rows.length > 0;
  }

  /** 대표는 학생당 하나 — 새 대표를 세우기 전에 전 대표를 내린다 (부분 유니크 guardian_one_primary 가 마지막 방어) */
  private async demotePrimary(q: QueryRunner, studentId: number): Promise<void> {
    await q.query(`UPDATE guardian SET is_primary = false WHERE student_id = $1 AND is_primary`, [studentId]);
  }

  private async log(
    q: QueryRunner, actorId: number, entity: 'GUARDIAN' | 'GUARDIAN_SEND', entityId: number, action: string,
    before: Record<string, unknown> | null, after: Record<string, unknown>,
  ): Promise<void> {
    await q.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [actorId, entity, entityId, action, before ? JSON.stringify(before) : null, JSON.stringify(after)],
    );
  }

  private async tx<T>(run: (q: QueryRunner) => Promise<T>): Promise<T> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const value = await run(q);
      await q.commitTransaction();
      return value;
    } catch (error) {
      await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }
}

/** 연락처는 최소 하나 · 받는 채널에는 그 연락처가 있어야 한다 — DB CHECK 와 같은 규칙을 사람 말로 먼저 막는다 */
function assertContacts(v: { email: string | null; phone: string | null; receiveEmail: boolean; receiveSms: boolean }): void {
  if (v.email === null && v.phone === null) {
    throw new BadRequestException({ code: 'GUARDIAN_CONTACT_REQUIRED', message: '메일 주소나 휴대폰 번호 중 하나는 있어야 합니다' });
  }
  const probe = { email: v.email, phone: v.phone, receive_email: true, receive_sms: true } as GuardianRow;
  const wants: Record<SendChannel, boolean> = { email: v.receiveEmail, sms: v.receiveSms };
  for (const channel of SEND_CHANNELS) {
    if (wants[channel] && RECEIVES[channel].contact(probe) === null) {
      throw new BadRequestException({ code: 'GUARDIAN_CHANNEL_CONTACT', message: RECEIVES[channel].missingContact });
    }
  }
}

function phoneDisplay(d: string | null): string | null {
  if (!d) return null;
  if (d.startsWith('02')) return `02-${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}`;
}

function toDto(r: GuardianRow): GuardianDto {
  return {
    id: Number(r.id), studentId: Number(r.student_id), name: r.name, relation: r.relation,
    email: r.email, phone: r.phone, phoneDisplay: phoneDisplay(r.phone),
    receiveEmail: r.receive_email, receiveSms: r.receive_sms,
    receives: SEND_CHANNELS.filter((c) => RECEIVES[c].accepts(r)),
    isPrimary: r.is_primary, active: r.active,
    createdAt: r.created_at,
  };
}

/** LOG 에 남기는 모양 — 연락처는 가린 값만 */
function snapshot(r: GuardianRow): Record<string, unknown> {
  return {
    studentId: Number(r.student_id), name: r.name, relation: r.relation,
    email: r.email === null ? null : CHANNEL_SPECS.email.mask(r.email),
    phone: r.phone === null ? null : CHANNEL_SPECS.sms.mask(r.phone),
    receiveEmail: r.receive_email, receiveSms: r.receive_sms, isPrimary: r.is_primary, active: r.active,
  };
}

function counts(rows: LedgerRow[], skipped: number) {
  return {
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    notConfigured: rows.filter((r) => r.status === 'not_configured').length,
    skipped,
  };
}

function summary(c: ReturnType<typeof counts>): string {
  const parts = [
    c.sent > 0 ? `${c.sent}건 보냈습니다` : null,
    c.failed > 0 ? `${c.failed}건 보내지 못했습니다` : null,
    c.notConfigured > 0 ? `${c.notConfigured}건은 설정이 없어 보내지 않았습니다` : null,
    c.skipped > 0 ? `${c.skipped}건은 받지 않는 채널이라 건너뛰었습니다` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(' · ');
}
