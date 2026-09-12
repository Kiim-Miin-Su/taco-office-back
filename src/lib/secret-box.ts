/** @file-guide
 * 목적: secret-box.ts — sealSecret, openSecret, secretKeyFrom (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 줌 로그인 비밀·회의 비밀번호를 **평문으로 두지 않는다** (init 마이그레이션 주석 · erd v4.3).
 *
 * AES-256-GCM 이다. 왜 GCM 인가 — 복호화할 때 **훼손을 알아챈다.** CBC 는 조용히 이상한 바이트를
 * 내놓고, 그러면 「비밀번호가 틀렸다」와 「저장이 깨졌다」를 구별할 수 없다.
 *
 * 저장 모양은 한 덩어리다: `iv(12) || tag(16) || cipher`. 열 하나(bytea)에 들어가고,
 * 여는 쪽이 자리만 알면 된다 — 형식 낱말을 따로 저장하지 않는다.
 *
 * 키는 `ZOOM_ENC_KEY` 다. 키가 없으면 **봉하지도 열지도 않는다** — 평문으로 흘려보내는
 * 대비책을 두지 않는다. 그런 대비책은 있는 줄도 모르고 켜져 있는 날이 온다.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV = 12;
const TAG = 16;

/** 어떤 길이의 문자열 키든 32바이트로 — SHA-256 한 번. 키 회전은 대표 결정이 있을 때 별도로 한다 */
export function secretKeyFrom(raw: string | undefined): Buffer | null {
  const key = raw?.trim();
  return key ? createHash('sha256').update(key).digest() : null;
}

export function sealSecret(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** 열 수 없으면 null 이다 — 훼손됐는지 키가 다른지를 부르는 쪽이 사람 말로 옮긴다 */
export function openSecret(sealed: Buffer, key: Buffer): string | null {
  if (sealed.length <= IV + TAG) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV));
    d.setAuthTag(sealed.subarray(IV, IV + TAG));
    return Buffer.concat([d.update(sealed.subarray(IV + TAG)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
