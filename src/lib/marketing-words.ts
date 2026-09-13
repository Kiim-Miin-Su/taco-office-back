/** @file-guide
 * 목적: marketing-words.ts — MKT_CHANNEL_LABEL, MKT_ITEM_LABEL, mktChannelLabel, mktItemLabel, mktTitle 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §59 마케팅 · §60 대표 피드백의 **낱말 한 벌**.
 *
 * 지금까지 §59 표는 `channel` · `item` 코드값을 **그대로** 화면에 찍고 있었다 — 「instagram」
 * 「ad」. 낱말을 만드는 자리는 서버 한 곳이다 (D-R18).
 *
 * ⚠️ **원문과 어휘가 다르다.** 원문 §59 의 채널은 「카카오채널 · 네이버 광고 · 인스타그램 ·
 * 네이버 블로그 …」이고 항목은 「댓글·응대 · 광고 집행 · 릴스·영상 · 글 발행 …」인데, 표에
 * 들어 있는 코드는 `instagram/naver/daangn/kakao/youtube/referral/flyer` ×
 * `ad/blog/biz/channel/video/word/print` 이고 시드에서 **채널 하나에 항목 하나**로 붙어 있다.
 * 원문은 같은 「네이버」가 광고와 블로그 둘로 갈리고 항목이 따로 움직인다 — **모양이 다르다.**
 * 아래 이름표는 **우리 코드값을 한글로 옮긴 것**이지 원문 7종을 주장하는 것이 아니다.
 * 원문 어휘로 맞추는 일은 §59 화면 청크에서 한다 (N-29).
 */
export const MKT_CHANNEL_LABEL: Record<string, string> = {
  instagram: '인스타그램',
  naver: '네이버',
  daangn: '당근',
  kakao: '카카오',
  youtube: '유튜브',
  referral: '소개',
  flyer: '전단',
};

export const MKT_ITEM_LABEL: Record<string, string> = {
  ad: '광고',
  blog: '블로그 글',
  biz: '비즈니스',
  channel: '채널 응대',
  video: '영상',
  word: '입소문',
  print: '인쇄물',
};

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

/** 쓸 때의 종류를 그대로 적는다 — 「쓴 사람의 지금 역할」로 되짚지 않는다 */
export const MFB_KINDS = ['comment', 'reply'] as const;
export type MfbKind = (typeof MFB_KINDS)[number];

export const MFB_KIND_LABEL: Record<MfbKind, string> = {
  comment: '대표 코멘트',
  reply: '담당자 답변',
};

/**
 * 원문 §60 카드 왼쪽 위의 칩 두 개. **셋째 칩은 원문에 없다** —
 * 「보류」 단추를 누른 뒤 카드가 어떤 칩을 다는지 원문이 보여 주지 않아 만들지 않았다 (N-29).
 */
export const MFB_STATES = ['fixed', 'needs_fix'] as const;
export type MfbState = (typeof MFB_STATES)[number];

export const MFB_STATE_LABEL: Record<MfbState, string> = {
  fixed: '고쳤습니다',
  needs_fix: '확인 필요',
};

export const mfbStateLabel = (state: string): string => MFB_STATE_LABEL[state as MfbState] ?? state;
