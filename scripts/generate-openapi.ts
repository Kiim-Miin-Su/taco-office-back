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

  /**
   * 타입이 안 붙은 속성을 잡는다.
   *
   * `@ApiProperty()` 만 적고 `number | null` 같은 유니온을 쓰면 스웨거가 **빈 스키마**를 내보내고,
   * 프론트 생성 타입이 `Record<string, never>` 가 되어 화면에서 컴파일이 깨진다.
   * 두 번 겪었으므로 여기서 막는다 — 계약이 비어 있는 채로 나가지 않게.
   */
  const bare: string[] = [];
  const schemas = (doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, object> }>;
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [prop, spec] of Object.entries(schema.properties ?? {})) {
      const keys = Object.keys(spec ?? {}).filter((k) => k !== 'description' && k !== 'nullable');
      if (keys.length === 0) bare.push(`${name}.${prop}`);
    }
  }
  if (bare.length) {
    console.error('타입이 비어 있는 속성이 있습니다 — @ApiProperty({ type: …, nullable: true }) 를 적어 주세요:');
    for (const b of bare) console.error(`  ${b}`);
    await app.close();
    process.exit(1);
  }

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
