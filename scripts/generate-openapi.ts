/**
 * openapi.json 을 파일로 뽑는다. `npm run openapi:gen`
 *
 * `--check` 를 주면 커밋된 것과 다른지만 본다 — CI 에서 "DTO 를 고치고 생성물을
 * 갱신하지 않은 커밋"을 잡기 위한 것이다.
 */
import 'reflect-metadata';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { buildOpenApi } from '../src/openapi';

const OUT = join(__dirname, '..', 'openapi.json');

async function main() {
  const check = process.argv.includes('--check');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const doc = buildOpenApi(app);
  const next = JSON.stringify(doc, null, 2) + '\n';
  await app.close();

  if (check) {
    const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (prev !== next) {
      console.error('openapi.json 이 DTO 와 다릅니다 — `npm run openapi:gen` 을 돌리고 함께 커밋하세요.');
      process.exit(1);
    }
    console.log('openapi.json 최신입니다.');
    return;
  }
  writeFileSync(OUT, next);
  console.log(`openapi.json 생성 — 경로 ${Object.keys(doc.paths ?? {}).length}개`);
}

void main();
