import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 1755000000000-init.ts — 첫 스키마.
 *
 * 출처: docs/contracts/db/erd.dbml **v4.2** (58표).
 * GPA 4표(GPASVC · GPA_CYCLE · GPA_ALLOC · GPA_USE)는 **N-13 결정 대기**라 빠져 있습니다.
 * 결정이 오면 별도 마이그레이션으로 붙입니다 — 이 파일을 고치지 않습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 그대로 씁니다 (명세서 §82).
 *
 * ⚠️ 이 파일의 CREATE TABLE 부분은 dbml 에서 생성했습니다.
 *    아래 §부록(제약)은 **손으로 적은 것**이며 dbml 부록 A 와 1:1 입니다.
 */
export class Init1755000000000 implements MigrationInterface {
  name = 'Init1755000000000';

  public async up(q: QueryRunner): Promise<void> {
    /* ── 확장 ────────────────────────────────────────────────────
       btree_gist 가 있어야 EXCLUDE 제약에서 = 과 && 를 같이 쓸 수 있다. */
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    await q.query(`CREATE TYPE class_mode_t AS ENUM ('offline', 'online')`);
    await q.query(`CREATE TYPE cons_share_t AS ENUM ('all', 'money_only', 'picked', 'private')`);
    await q.query(`CREATE TYPE cpl_area_t AS ENUM ('lesson', 'intake', 'book', 'schedule', 'teacher')`);
    await q.query(`CREATE TYPE guide_state_t AS ENUM ('draft', 'ready', 'sent', 'read')`);
    await q.query(`CREATE TYPE inv_state_t AS ENUM ('draft', 'sent', 'unpaid', 'partial', 'paid', 'void')`);
    await q.query(`CREATE TYPE kind_grp_t AS ENUM ('lesson', 'intake', 'meeting')`);
    await q.query(`CREATE TYPE rep_state_t AS ENUM ('na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej')`);
    await q.query(`CREATE TYPE role_t AS ENUM ('teacher', 'manager', 'admin', 'ceo')`);
    await q.query(`CREATE TYPE sug_cat_t AS ENUM ('lesson', 'pay', 'schedule', 'etc')`);
    await q.query(`CREATE TYPE sug_state_t AS ENUM ('open', 'reviewing', 'done')`);
    await q.query(`CREATE TYPE todo_src_t AS ENUM ('meeting', 'complaint', 'consulting', 'plan', 'manual')`);

    await q.query(`CREATE TABLE kind (
      key varchar(16) NOT NULL,
      name varchar(30) NOT NULL,
      color char(7) NOT NULL,
      cap smallint NOT NULL,
      grp kind_grp_t NOT NULL,
      rep boolean NOT NULL DEFAULT false,
      rep_form varchar(16),
      sort smallint,
      PRIMARY KEY (key)
    )`);
    await q.query(`CREATE TABLE sub (
      key varchar(20) NOT NULL,
      name varchar(40) NOT NULL,
      color char(7) NOT NULL,
      active boolean NOT NULL DEFAULT true,
      sort smallint,
      PRIMARY KEY (key)
    )`);
    await q.query(`CREATE TABLE staff (
      id bigserial NOT NULL,
      name varchar(40) NOT NULL,
      email varchar(120) NOT NULL UNIQUE,
      phone varchar(20),
      role role_t NOT NULL,
      title varchar(20),
      tz varchar(40) NOT NULL DEFAULT 'Asia/Seoul',
      password_hash varchar(72),
      last_login_at timestamptz,
      phone_verified boolean NOT NULL DEFAULT false,
      can_money boolean,
      can_wage boolean,
      can_approve boolean,
      can_hide boolean,
      can_gpa_pack boolean,
      hired_on date,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE stu (
      id bigserial NOT NULL,
      name varchar(40) NOT NULL,
      grade varchar(10),
      school varchar(60),
      target_exam varchar(40),
      started_on date,
      guidance varchar(20),
      lang varchar(20),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE lead (
      id bigserial NOT NULL,
      student_id bigint,
      name varchar(40) NOT NULL,
      school varchar(60),
      owner_id bigint,
      stage varchar(16) NOT NULL,
      stop_at varchar(16),
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE enr (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      kind_key varchar(16) NOT NULL,
      sub_key varchar(20),
      sessions smallint,
      started_on date,
      ended_on date,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE tzg (
      id bigserial NOT NULL,
      name varchar(40) NOT NULL,
      tz varchar(40) NOT NULL,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE room (
      id bigserial NOT NULL,
      branch varchar(20) NOT NULL,
      name varchar(40) NOT NULL,
      capacity smallint,
      active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE zacc (
      id bigserial NOT NULL,
      label varchar(20) NOT NULL UNIQUE,
      login_email varchar(120) NOT NULL,
      -- 줌 로그인 비밀과 회의 비밀번호는 평문으로 두지 않는다 (AES-256 · 키는 별도 저장소).
      -- erd v4.3 에 있었는데 여기에 빠져 있었다 — 시드가 걸려서 드러났다 (TBO-26).
      login_secret bytea NOT NULL,
      join_url text NOT NULL,
      meeting_id varchar(30),
      meeting_pw_enc bytea,
      active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE zassign (
      id bigserial NOT NULL,
      ser_id bigint,
      exc_id bigint,
      zacc_id bigint NOT NULL,
      fixed boolean NOT NULL DEFAULT true,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE zlog (
      id bigserial NOT NULL,
      zacc_id bigint NOT NULL,
      actor_id bigint NOT NULL,
      action varchar(20) NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE ser (
      id bigserial NOT NULL,
      kind_key varchar(16) NOT NULL,
      sub_key varchar(20),
      teacher_id bigint,
      room_id bigint,
      mode class_mode_t NOT NULL,
      start_min smallint NOT NULL,
      end_min smallint NOT NULL,
      rrule varchar(80) NOT NULL,
      from_date date NOT NULL,
      to_date date,
      title varchar(80),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE ser_stu (
      ser_id bigint NOT NULL,
      student_id bigint NOT NULL,
      PRIMARY KEY (ser_id, student_id)
    )`);
    await q.query(`CREATE TABLE exc (
      id bigserial NOT NULL,
      ser_id bigint NOT NULL,
      on_date date NOT NULL,
      canceled boolean NOT NULL DEFAULT false,
      new_date date,
      start_min smallint,
      end_min smallint,
      teacher_id bigint,
      room_id bigint,
      reason text,
      by_id bigint,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE exc_stu_out (
      exc_id bigint NOT NULL,
      student_id bigint NOT NULL,
      PRIMARY KEY (exc_id, student_id)
    )`);
    await q.query(`CREATE TABLE unav (
      id bigserial NOT NULL,
      staff_id bigint NOT NULL,
      cycle smallint,
      dow smallint NOT NULL,
      start_min smallint NOT NULL,
      end_min smallint NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE chreq (
      id bigserial NOT NULL,
      ser_id bigint,
      on_date date,
      req_type varchar(12) NOT NULL,
      payload jsonb NOT NULL,
      reason text NOT NULL,
      state varchar(12) NOT NULL DEFAULT 'open',
      by_id bigint NOT NULL,
      resolved_by bigint,
      resolved_at timestamptz,
      apply_all boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE rep (
      id bigserial NOT NULL,
      ser_id bigint NOT NULL,
      on_date date NOT NULL,
      -- 학생은 여기 없다. 리포트는 수업 하나에 하나이고 학생은 rep_stu 가 갖는다.
      -- (ser_id, on_date) 유니크와 student_id NOT NULL 은 그룹 수업에서 함께 성립할 수 없다 (TBO-26).
      teacher_id bigint,
      kind_key varchar(16),
      lang varchar(2) NOT NULL DEFAULT 'ko',
      body jsonb NOT NULL,
      state rep_state_t NOT NULL DEFAULT 'none',
      written_at timestamptz,
      submitted_at timestamptz,
      reviewed_at timestamptz,
      reviewer_id bigint,
      reject_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE autorep (
      id bigserial NOT NULL,
      ser_id bigint NOT NULL,
      on_date date NOT NULL,
      body jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE rep_stu (
      rep_id bigint NOT NULL,
      student_id bigint NOT NULL,
      comment text,
      deliver boolean NOT NULL DEFAULT true,
      PRIMARY KEY (rep_id, student_id)
    )`);
    await q.query(`CREATE TABLE rsend (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      on_date date NOT NULL,
      rep_ids jsonb NOT NULL,
      channel varchar(10) NOT NULL,
      body text NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      sent_by bigint NOT NULL,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE wrep (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      week_of date NOT NULL,
      body jsonb,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE guide (
      id bigserial NOT NULL,
      ser_id bigint,
      student_id bigint NOT NULL,
      teacher_id bigint,
      reason varchar(20) NOT NULL,
      state guide_state_t NOT NULL DEFAULT 'draft',
      body text,
      due_on date,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE pnoti (
      id bigserial NOT NULL,
      ser_id bigint,
      on_date date,
      student_id bigint NOT NULL,
      channel varchar(10) NOT NULL,
      body text NOT NULL,
      sent_at timestamptz,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE gtpl (
      id bigserial NOT NULL,
      name varchar(40) NOT NULL,
      body text NOT NULL,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE lib (
      id bigserial NOT NULL,
      code varchar(30) NOT NULL UNIQUE,
      title varchar(120) NOT NULL,
      sub_key varchar(20),
      level varchar(20),
      grade varchar(10),
      pages smallint,
      se_te varchar(4),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE vers (
      id bigserial NOT NULL,
      lib_id bigint NOT NULL,
      edition varchar(20) NOT NULL,
      file_url text,
      from_date date,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE issue (
      id bigserial NOT NULL,
      lib_id bigint NOT NULL,
      vers_id bigint,
      student_id bigint NOT NULL,
      issued_on date NOT NULL,
      returned_on date,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE hist (
      id bigserial NOT NULL,
      entity varchar(12) NOT NULL,
      ref_id bigint NOT NULL,
      action varchar(20) NOT NULL,
      by_id bigint,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE gpapack (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      pack_type varchar(12) NOT NULL,
      detail text,
      state varchar(12) NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE rate (
      id bigserial NOT NULL,
      kind_key varchar(16) NOT NULL,
      sub_key varchar(20),
      unit_price integer NOT NULL,
      from_date date NOT NULL,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE sturate (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      kind_key varchar(16),
      unit_price integer NOT NULL,
      from_date date NOT NULL,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE wage (
      id bigserial NOT NULL,
      staff_id bigint NOT NULL,
      rate integer NOT NULL,
      from_date date NOT NULL,
      reason text,
      approved_by bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE inv (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      enr_id bigint,
      year_month varchar(7) NOT NULL,
      inv_type varchar(16) NOT NULL,
      title varchar(80) NOT NULL,
      amount integer NOT NULL,
      detail jsonb,
      state inv_state_t NOT NULL DEFAULT 'draft',
      issued_on date,
      due_on date,
      sent_at timestamptz,
      created_by bigint,
      paid_amount integer NOT NULL DEFAULT 0,
      paid_at timestamptz,
      proof_url text,
      memo varchar(500),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE inv_line (
      id bigserial NOT NULL,
      inv_id bigint NOT NULL,
      sub_key varchar(16),
      label varchar(80) NOT NULL,
      count integer NOT NULL,
      unit_price integer NOT NULL,
      amount integer NOT NULL,
      seq smallint NOT NULL DEFAULT 0,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE pay (
      id bigserial NOT NULL,
      inv_id bigint,
      student_id bigint,
      amount integer,
      paid_on date,
      method varchar(16),
      reason text,
      entered_by bigint,
      entered_at timestamptz,
      confirmed_by bigint,
      confirmed_at timestamptz,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE payout (
      id bigserial NOT NULL,
      staff_id bigint NOT NULL,
      year_month varchar(7) NOT NULL,
      hours numeric(6,2) NOT NULL,
      gross integer NOT NULL,
      late_rep_cut integer NOT NULL DEFAULT 0,
      late_cls_cut integer NOT NULL DEFAULT 0,
      income_tax integer NOT NULL DEFAULT 0,
      local_tax integer NOT NULL DEFAULT 0,
      net integer NOT NULL,
      state varchar(12) NOT NULL DEFAULT 'draft',
      confirmed_by bigint,
      confirmed_at timestamptz,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE payout_line (
      id bigserial NOT NULL,
      payout_id bigint NOT NULL,
      ser_id bigint,
      on_date date,
      kind_key varchar(16),
      hours numeric(4,2) NOT NULL,
      unit_rate integer NOT NULL,
      amount integer NOT NULL,
      cut integer NOT NULL DEFAULT 0,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE expense (
      id bigserial NOT NULL,
      spend_on date NOT NULL,
      category varchar(30) NOT NULL,
      merchant varchar(80),
      purpose text,
      requested_amount integer,
      amount integer,
      reason text,
      receipt_url text,
      requester_id bigint,
      state varchar(12) NOT NULL DEFAULT 'submitted',
      reviewer_id bigint,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE cons (
      id bigserial NOT NULL,
      cons_type varchar(20) NOT NULL,
      stage varchar(12) NOT NULL,
      contract_step smallint,
      amount integer,
      sessions smallint,
      end_on date,
      owner_id bigint,
      share cons_share_t NOT NULL DEFAULT 'all',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE cons_stu (
      cons_id bigint NOT NULL,
      student_id bigint NOT NULL,
      PRIMARY KEY (cons_id, student_id)
    )`);
    await q.query(`CREATE TABLE cons_pick (
      cons_id bigint NOT NULL,
      staff_id bigint NOT NULL,
      PRIMARY KEY (cons_id, staff_id)
    )`);
    await q.query(`CREATE TABLE cons_sess (
      id bigserial NOT NULL,
      cons_id bigint NOT NULL,
      seq smallint NOT NULL,
      on_date date,
      who text,
      what text,
      why text,
      how text,
      ser_id bigint,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE cpl (
      id bigserial NOT NULL,
      area cpl_area_t NOT NULL,
      student_id bigint,
      stage varchar(12) NOT NULL,
      body text NOT NULL,
      action text,
      result text,
      teacher_changed boolean NOT NULL DEFAULT false,
      owner_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE plan (
      id bigserial NOT NULL,
      title varchar(120) NOT NULL,
      stage varchar(12) NOT NULL,
      goal text,
      tasks jsonb,
      research text,
      ask text,
      due_on date,
      owner_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE mkt (
      id bigserial NOT NULL,
      channel varchar(20) NOT NULL,
      item varchar(20) NOT NULL,
      url text,
      result jsonb,
      on_date date,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE mfb (
      id bigserial NOT NULL,
      mkt_id bigint,
      by_id bigint NOT NULL,
      body text NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE mtrec (
      id bigserial NOT NULL,
      mt_type varchar(12) NOT NULL,
      title varchar(120),
      on_date date,
      pre_files jsonb,
      minutes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE mtattd (
      mt_id bigint NOT NULL,
      staff_id bigint NOT NULL,
      confirmed boolean,
      PRIMARY KEY (mt_id, staff_id)
    )`);
    await q.query(`CREATE TABLE todo (
      id bigserial NOT NULL,
      title varchar(160) NOT NULL,
      from_id bigint,
      to_id bigint,
      due_on date,
      done boolean NOT NULL DEFAULT false,
      src todo_src_t NOT NULL DEFAULT 'manual',
      mt_id bigint,
      cpl_id bigint,
      cons_id bigint,
      plan_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE req (
      id bigserial NOT NULL,
      staff_id bigint NOT NULL,
      req_type varchar(16) NOT NULL,
      payload jsonb,
      state varchar(12) NOT NULL DEFAULT 'open',
      resolved_by bigint,
      reject_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE noti (
      id bigserial NOT NULL,
      to_id bigint NOT NULL,
      from_id bigint,
      body text NOT NULL,
      link varchar(80),
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE log (
      id bigserial NOT NULL,
      actor_id bigint NOT NULL,
      entity varchar(20) NOT NULL,
      entity_id bigint NOT NULL,
      action varchar(20) NOT NULL,
      before jsonb,
      after jsonb,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE rpt (
      id bigserial NOT NULL,
      rpt_type varchar(8) NOT NULL,
      on_date date NOT NULL,
      memo jsonb NOT NULL,
      state varchar(8) NOT NULL DEFAULT 'draft',
      sent_at timestamptz,
      reviewed_at timestamptz,
      reject_reason text,
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE pdflog (
      id bigserial NOT NULL,
      kind varchar(16) NOT NULL,
      ref_id bigint,
      file_url text,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE suggestion (
      id bigserial NOT NULL,
      staff_id bigint NOT NULL,
      category sug_cat_t NOT NULL,
      body text NOT NULL,
      state sug_state_t NOT NULL DEFAULT 'open',
      reply text,
      reply_by bigint,
      reply_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE note (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      ser_id bigint,
      author_id bigint NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(`CREATE TABLE diag (
      id bigserial NOT NULL,
      student_id bigint NOT NULL,
      ser_id bigint,
      level_summary text NOT NULL,
      strengths text,
      weaknesses text,
      curriculum text,
      created_by bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);

    /* ── 인덱스 ─────────────────────────────────────────────── */
    await q.query(`CREATE UNIQUE INDEX room_branch_name_uniq ON room (branch, name)`);
    await q.query(`CREATE INDEX ser_from_date_to_date_idx ON ser (from_date, to_date)`);
    await q.query(`CREATE INDEX ser_teacher_id_idx ON ser (teacher_id)`);
    await q.query(`CREATE INDEX ser_room_id_idx ON ser (room_id)`);
    await q.query(`CREATE UNIQUE INDEX exc_ser_id_on_date_uniq ON exc (ser_id, on_date)`);
    await q.query(`CREATE INDEX unav_staff_id_cycle_dow_idx ON unav (staff_id, cycle, dow)`);
    await q.query(`CREATE UNIQUE INDEX rep_ser_id_on_date_uniq ON rep (ser_id, on_date)`);
    await q.query(`CREATE INDEX rep_state_submitted_at_idx ON rep (state, submitted_at)`);
    await q.query(`CREATE INDEX rep_teacher_id_on_date_idx ON rep (teacher_id, on_date)`);
    await q.query(`CREATE UNIQUE INDEX autorep_ser_id_on_date_uniq ON autorep (ser_id, on_date)`);
    await q.query(`CREATE UNIQUE INDEX wrep_student_id_week_of_uniq ON wrep (student_id, week_of)`);
    await q.query(`CREATE UNIQUE INDEX wage_staff_id_from_date_uniq ON wage (staff_id, from_date)`);
    await q.query(`CREATE INDEX inv_student_id_year_month_idx ON inv (student_id, year_month)`);
    await q.query(`CREATE INDEX inv_state_due_on_idx ON inv (state, due_on)`);
    await q.query(`CREATE INDEX inv_line_inv_id_seq_idx ON inv_line (inv_id, seq)`);
    await q.query(`CREATE INDEX pay_inv_id_idx ON pay (inv_id)`);
    await q.query(`CREATE INDEX pay_paid_on_idx ON pay (paid_on)`);
    await q.query(`CREATE UNIQUE INDEX payout_staff_id_year_month_uniq ON payout (staff_id, year_month)`);
    await q.query(`CREATE INDEX expense_state_created_at_idx ON expense (state, created_at)`);
    await q.query(`CREATE INDEX expense_spend_on_idx ON expense (spend_on)`);
    await q.query(`CREATE INDEX log_entity_entity_id_at_idx ON log (entity, entity_id, at)`);
    await q.query(`CREATE UNIQUE INDEX rpt_rpt_type_on_date_uniq ON rpt (rpt_type, on_date)`);
    await q.query(`CREATE INDEX suggestion_staff_id_created_at_idx ON suggestion (staff_id, created_at)`);
    await q.query(`CREATE INDEX note_student_id_created_at_idx ON note (student_id, created_at)`);

    /* ════════════════════════════════════════════════════════════
       부록 A — 원자성 3층의 ③번 (D-R43 · docs/contracts/STACK.md §1.2)

       겹침을 막는 최종 방어선은 애플리케이션이 아니라 여기다.
       guardResource() 는 사용자에게 미리 알려 주기 위한 **안내**이고,
       두 사람이 같은 순간에 저장을 눌렀을 때 막는 것은 이 제약이다.
       ════════════════════════════════════════════════════════════ */

    /* ── 중복 금지 — 재시도·더블클릭이 두 줄을 만들지 않게 ────────── */
    await q.query(`ALTER TABLE rpt ADD CONSTRAINT rpt_type_date_uniq UNIQUE (rpt_type, on_date)`);
    await q.query(`ALTER TABLE rep ADD CONSTRAINT rep_ser_date_uniq UNIQUE (ser_id, on_date)`);
    await q.query(`ALTER TABLE exc ADD CONSTRAINT exc_ser_date_uniq UNIQUE (ser_id, on_date)`);
    await q.query(
      `ALTER TABLE payout ADD CONSTRAINT payout_staff_month_uniq UNIQUE (staff_id, year_month)`,
    );

    /* ── 금액이 음수가 되거나 청구액을 넘지 않게 ─────────────────── */
    await q.query(
      `ALTER TABLE inv ADD CONSTRAINT inv_paid_le_amount
         CHECK (paid_amount >= 0 AND paid_amount <= amount)`,
    );
    await q.query(`ALTER TABLE payout ADD CONSTRAINT payout_net_nonneg CHECK (net >= 0)`);

    /* ── 겹침 금지 (D-R43) ───────────────────────────────────────
       SER 은 반복 규칙이라 기간이 열려 있다. 그래서 제약은 **전개된 회차**에 건다.
       ser_occ 는 occ() 와 같은 규칙으로 채우는 물리 테이블이며,
       SER/EXC 가 바뀔 때 같은 트랜잭션 안에서 다시 채운다.
       판정을 애플리케이션이 아니라 DB 가 하게 만드는 것이 목적이다.        */
    await q.query(`CREATE TABLE ser_occ (
      id          bigserial PRIMARY KEY,
      ser_id      bigint NOT NULL,
      on_date     date NOT NULL,
      teacher_id  bigint,
      room_id     bigint,
      zacc_id     bigint,
      canceled    boolean NOT NULL DEFAULT false,
      span        tstzrange NOT NULL
    )`);
    await q.query(`CREATE UNIQUE INDEX ser_occ_ser_date_uniq ON ser_occ (ser_id, on_date)`);

    await q.query(`ALTER TABLE ser_occ ADD CONSTRAINT ser_occ_room_no_overlap
      EXCLUDE USING gist (room_id WITH =, span WITH &&)
      WHERE (canceled = false AND room_id IS NOT NULL)`);

    await q.query(`ALTER TABLE ser_occ ADD CONSTRAINT ser_occ_teacher_no_overlap
      EXCLUDE USING gist (teacher_id WITH =, span WITH &&)
      WHERE (canceled = false AND teacher_id IS NOT NULL)`);

    await q.query(`ALTER TABLE ser_occ ADD CONSTRAINT ser_occ_zoom_no_overlap
      EXCLUDE USING gist (zacc_id WITH =, span WITH &&)
      WHERE (canceled = false AND zacc_id IS NOT NULL)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS ser_occ CASCADE`);
await q.query(`DROP TABLE IF EXISTS diag CASCADE`);
    await q.query(`DROP TABLE IF EXISTS note CASCADE`);
    await q.query(`DROP TABLE IF EXISTS suggestion CASCADE`);
    await q.query(`DROP TABLE IF EXISTS pdflog CASCADE`);
    await q.query(`DROP TABLE IF EXISTS rpt CASCADE`);
    await q.query(`DROP TABLE IF EXISTS log CASCADE`);
    await q.query(`DROP TABLE IF EXISTS noti CASCADE`);
    await q.query(`DROP TABLE IF EXISTS req CASCADE`);
    await q.query(`DROP TABLE IF EXISTS todo CASCADE`);
    await q.query(`DROP TABLE IF EXISTS mtattd CASCADE`);
    await q.query(`DROP TABLE IF EXISTS mtrec CASCADE`);
    await q.query(`DROP TABLE IF EXISTS mfb CASCADE`);
    await q.query(`DROP TABLE IF EXISTS mkt CASCADE`);
    await q.query(`DROP TABLE IF EXISTS plan CASCADE`);
    await q.query(`DROP TABLE IF EXISTS cpl CASCADE`);
    await q.query(`DROP TABLE IF EXISTS cons_sess CASCADE`);
    await q.query(`DROP TABLE IF EXISTS cons_pick CASCADE`);
    await q.query(`DROP TABLE IF EXISTS cons_stu CASCADE`);
    await q.query(`DROP TABLE IF EXISTS cons CASCADE`);
    await q.query(`DROP TABLE IF EXISTS expense CASCADE`);
    await q.query(`DROP TABLE IF EXISTS payout_line CASCADE`);
    await q.query(`DROP TABLE IF EXISTS payout CASCADE`);
    await q.query(`DROP TABLE IF EXISTS pay CASCADE`);
    await q.query(`DROP TABLE IF EXISTS inv_line CASCADE`);
    await q.query(`DROP TABLE IF EXISTS inv CASCADE`);
    await q.query(`DROP TABLE IF EXISTS wage CASCADE`);
    await q.query(`DROP TABLE IF EXISTS sturate CASCADE`);
    await q.query(`DROP TABLE IF EXISTS rate CASCADE`);
    await q.query(`DROP TABLE IF EXISTS gpapack CASCADE`);
    await q.query(`DROP TABLE IF EXISTS hist CASCADE`);
    await q.query(`DROP TABLE IF EXISTS issue CASCADE`);
    await q.query(`DROP TABLE IF EXISTS vers CASCADE`);
    await q.query(`DROP TABLE IF EXISTS lib CASCADE`);
    await q.query(`DROP TABLE IF EXISTS gtpl CASCADE`);
    await q.query(`DROP TABLE IF EXISTS pnoti CASCADE`);
    await q.query(`DROP TABLE IF EXISTS guide CASCADE`);
    await q.query(`DROP TABLE IF EXISTS wrep CASCADE`);
    await q.query(`DROP TABLE IF EXISTS rsend CASCADE`);
    await q.query(`DROP TABLE IF EXISTS rep_stu CASCADE`);
    await q.query(`DROP TABLE IF EXISTS autorep CASCADE`);
    await q.query(`DROP TABLE IF EXISTS rep CASCADE`);
    await q.query(`DROP TABLE IF EXISTS chreq CASCADE`);
    await q.query(`DROP TABLE IF EXISTS unav CASCADE`);
    await q.query(`DROP TABLE IF EXISTS exc_stu_out CASCADE`);
    await q.query(`DROP TABLE IF EXISTS exc CASCADE`);
    await q.query(`DROP TABLE IF EXISTS ser_stu CASCADE`);
    await q.query(`DROP TABLE IF EXISTS ser CASCADE`);
    await q.query(`DROP TABLE IF EXISTS zlog CASCADE`);
    await q.query(`DROP TABLE IF EXISTS zassign CASCADE`);
    await q.query(`DROP TABLE IF EXISTS zacc CASCADE`);
    await q.query(`DROP TABLE IF EXISTS room CASCADE`);
    await q.query(`DROP TABLE IF EXISTS tzg CASCADE`);
    await q.query(`DROP TABLE IF EXISTS enr CASCADE`);
    await q.query(`DROP TABLE IF EXISTS lead CASCADE`);
    await q.query(`DROP TABLE IF EXISTS stu CASCADE`);
    await q.query(`DROP TABLE IF EXISTS staff CASCADE`);
    await q.query(`DROP TABLE IF EXISTS sub CASCADE`);
    await q.query(`DROP TABLE IF EXISTS kind CASCADE`);
    await q.query(`DROP TYPE IF EXISTS todo_src_t`);
    await q.query(`DROP TYPE IF EXISTS sug_state_t`);
    await q.query(`DROP TYPE IF EXISTS sug_cat_t`);
    await q.query(`DROP TYPE IF EXISTS role_t`);
    await q.query(`DROP TYPE IF EXISTS rep_state_t`);
    await q.query(`DROP TYPE IF EXISTS kind_grp_t`);
    await q.query(`DROP TYPE IF EXISTS inv_state_t`);
    await q.query(`DROP TYPE IF EXISTS guide_state_t`);
    await q.query(`DROP TYPE IF EXISTS cpl_area_t`);
    await q.query(`DROP TYPE IF EXISTS cons_share_t`);
    await q.query(`DROP TYPE IF EXISTS class_mode_t`);
  }
}
