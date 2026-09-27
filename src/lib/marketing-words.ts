/** @file-guide
 * 목적: marketing-words.ts — MKT_CHANNEL_LABEL, MKT_ITEM_LABEL, mktChannelLabel, mktItemLabel, mktTitle 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §59 마케팅 · §60 대표 피드백의 **낱말 한 벌**. 낱말을 만드는 자리는 서버 한 곳이다 (D-R18 · C53).
 *
 * W11 · N-29 ① 채택 — **원문 컷이 보여 주는 넷 · 넷**을 고를 수 있는 어휘로 둔다:
 * 채널 「카카오채널 · 네이버 광고 · 인스타그램 · 네이버 블로그」 · 항목 「댓글·응대 · 광고 집행 · 릴스·영상 · 글 발행」.
 * 원문 머리는 「채널 7종 · 항목 7종」이지만 나머지 셋 · 셋의 이름은 컷에 없다 — **짓지 않는다**(대표가 줄 때까지).
 * 채널과 항목은 **따로 움직인다**(원문에서 같은 「네이버」가 광고와 블로그로 갈린다 · 시드의 1:1 짝은 풀었다).
 *
 * 같은 것을 부르는 옛 코드는 낱말만 원문으로 맞췄다(kakao · instagram · ad · video — 코드는 그대로라 옛 행도 같은 뜻으로 읽힌다).
 * 원문 넷에 대응이 없는 옛 코드(`naver` 「네이버」 · 당근 · 유튜브 · 소개 · 전단 · 블로그 글 …)는 **옛 이름 그대로** 읽힌다 —
 * 이관하지 않는다(N-29 ① · N-25). 새로 적을 때는 고를 수 없다.
 */
export const MKT_CHANNEL_WORDS = [
  ['kakao', '카카오채널'],
  ['naver_ad', '네이버 광고'],
  ['instagram', '인스타그램'],
  ['naver_blog', '네이버 블로그'],
] as const;
export const MKT_ITEM_WORDS = [
  ['reply', '댓글·응대'],
  ['ad', '광고 집행'],
  ['video', '릴스·영상'],
  ['post', '글 발행'],
] as const;

/** 옛 행에만 있는 코드의 이름 — 읽기 전용(「+ 오늘 한 것」이 받지 않는다) */
const MKT_CHANNEL_LEGACY: Record<string, string> = {
  naver: '네이버', daangn: '당근', youtube: '유튜브', referral: '소개', flyer: '전단',
};
const MKT_ITEM_LEGACY: Record<string, string> = {
  blog: '블로그 글', biz: '비즈니스', channel: '채널 응대', word: '입소문', print: '인쇄물',
};

export const MKT_CHANNEL_LABEL: Record<string, string> = { ...Object.fromEntries(MKT_CHANNEL_WORDS), ...MKT_CHANNEL_LEGACY };
export const MKT_ITEM_LABEL: Record<string, string> = { ...Object.fromEntries(MKT_ITEM_WORDS), ...MKT_ITEM_LEGACY };

/**
 * 「+ 오늘 한 것」(§59 · x5)이 받는 코드 — **원문 넷 · 넷**이고 차례도 컷 그대로다(채널 칩 줄 · 항목 범례).
 * 표의 CHECK(`mkt_channel_words` · `mkt_item_words`)는 이 넷에 옛 코드를 더한 것이다 — 옛 행이 그대로 남는다.
 */
export const MKT_CHANNELS = MKT_CHANNEL_WORDS.map(([key]) => key) as readonly string[];
export const MKT_ITEMS = MKT_ITEM_WORDS.map(([key]) => key) as readonly string[];
/** 표가 받는 코드 전부 — 원문 넷 + 옛 코드 (migration 1764600000000 의 CHECK 와 같은 목록) */
export const MKT_CHANNEL_CODES = Object.keys(MKT_CHANNEL_LABEL) as readonly string[];
export const MKT_ITEM_CODES = Object.keys(MKT_ITEM_LABEL) as readonly string[];

/** 모르는 코드값이면 코드값을 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다 */
export const mktChannelLabel = (channel: string): string => MKT_CHANNEL_LABEL[channel] ?? channel;
export const mktItemLabel = (item: string): string => MKT_ITEM_LABEL[item] ?? item;

/**
 * 카드 이름 — `title` 이 있으면 그것, 없으면 채널·항목으로 부른다.
 * 옛 행에는 `title` 이 없다. 그렇다고 카드가 이름 없이 놓이면 §60 에서 무엇에 대한 코멘트인지
 * 알 수 없다 (C53 마이그레이션은 옛 행을 추정해서 채우지 않는다).
 */
export const mktTitle = (title: string | null | undefined, channel: string, item: string): string =>
  title?.trim() ? title.trim() : `${mktChannelLabel(channel)} · ${mktItemLabel(item)}`;

/* ── §60 대표 피드백 ──────────────────────────────────────────────────── */

/**
 * 쓸 때의 종류를 그대로 적는다 — 「쓴 사람의 지금 역할」로 되짚지 않는다.
 * `hold` — W11 · N-29 ③ 채택: 「보류」는 **담당 답변의 한 종류**다(원문 §60 확인 필요 카드의 「고친 것 알리기 · 보류」).
 */
export const MFB_KINDS = ['comment', 'reply', 'hold'] as const;
export type MfbKind = (typeof MFB_KINDS)[number];

export const MFB_KIND_LABEL: Record<MfbKind, string> = {
  comment: '대표 코멘트',
  reply: '담당자 답변',
  hold: '보류',
};

/** 담당이 쓰는 두 갈래 — 「고친 것 알리기」(reply) · 「보류」(hold). 보류는 카드를 풀지 않는다 */
export const MFB_ANSWER_KINDS = ['reply', 'hold'] as const;

/**
 * 원문 §60 카드 왼쪽 위의 칩 두 개. **셋째 칩은 만들지 않는다**(N-29 ③) — 보류한 카드는 「확인 필요」로 남고
 * 머리 「고쳐야 할 것 N건」에서 빠지지 않는다(컷의 등식 「고쳐야 할 것 = 확인 필요 카드 수」가 그대로 선다). 「고친 것 알리기」가 푼다.
 */
export const MFB_STATES = ['fixed', 'needs_fix'] as const;
export type MfbState = (typeof MFB_STATES)[number];

export const MFB_STATE_LABEL: Record<MfbState, string> = {
  fixed: '고쳤습니다',
  needs_fix: '확인 필요',
};

export const mfbStateLabel = (state: string): string => MFB_STATE_LABEL[state as MfbState] ?? state;
