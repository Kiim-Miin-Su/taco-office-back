/** @file-guide
 * 목적: 보호 계좌 payload의 versioned AES-256-GCM 봉인·복호화와 fail-closed 키 조회를 한 곳에서 소유한다.
 * 책임/재사용: 평문을 로그·오류에 넣지 않고 secret-box 형식을 재사용한다. HTTP 권한·DB 쓰기는 다루지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D1-PROTECTED-ACCOUNT-2026-10-09.md
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { openSecret, sealSecret, secretKeyFrom } from './secret-box';

export interface ProtectedAccountSecret {
  bank: string;
  accountNumber: string;
  holder: string;
}

const VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/;

function keyFor(version: string): Buffer {
  if (!VERSION_PATTERN.test(version)) {
    throw new ServiceUnavailableException({
      code: 'PROTECTED_ACCOUNT_KEY_UNAVAILABLE', message: '계좌 암호화 키 버전을 확인할 수 없습니다',
    });
  }
  const envName = `TACO_ACCOUNT_ENC_KEY_${version.toUpperCase()}`;
  const key = secretKeyFrom(process.env[envName]);
  if (!key) {
    throw new ServiceUnavailableException({
      code: 'PROTECTED_ACCOUNT_KEY_UNAVAILABLE', message: '계좌 암호화 키를 사용할 수 없습니다',
    });
  }
  return key;
}

export function activeProtectedAccountKeyVersion(): string {
  const version = (process.env.TACO_ACCOUNT_ENC_KEY_VERSION ?? '').trim().toLowerCase();
  if (!VERSION_PATTERN.test(version)) {
    throw new ServiceUnavailableException({
      code: 'PROTECTED_ACCOUNT_KEY_UNAVAILABLE', message: '활성 계좌 암호화 키 버전을 확인할 수 없습니다',
    });
  }
  return version;
}

export function sealProtectedAccount(secret: ProtectedAccountSecret): { ciphertext: Buffer; keyVersion: string } {
  const keyVersion = activeProtectedAccountKeyVersion();
  return { ciphertext: sealSecret(JSON.stringify(secret), keyFor(keyVersion)), keyVersion };
}

export function openProtectedAccount(ciphertext: Buffer, keyVersion: string): ProtectedAccountSecret {
  const plain = openSecret(ciphertext, keyFor(keyVersion));
  if (!plain) {
    throw new ServiceUnavailableException({
      code: 'PROTECTED_ACCOUNT_DECRYPT_FAILED', message: '계좌 원문을 확인할 수 없습니다',
    });
  }
  try {
    const value = JSON.parse(plain) as Partial<ProtectedAccountSecret>;
    if (typeof value.bank !== 'string' || typeof value.accountNumber !== 'string' || typeof value.holder !== 'string') {
      throw new Error('invalid payload');
    }
    return { bank: value.bank, accountNumber: value.accountNumber, holder: value.holder };
  } catch {
    throw new ServiceUnavailableException({
      code: 'PROTECTED_ACCOUNT_DECRYPT_FAILED', message: '계좌 원문을 확인할 수 없습니다',
    });
  }
}
