/** @file-guide
 * 목적: generate-openapi.ts (script)
 * 책임/재사용: 검사/생성/실행 도구의 책임만 소유한다. 대상 경로와 실행 권한을 확인하고 실패를 성공으로 기록하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
  /*
   * `abortOnError` 를 끈다. 기본값이면 **Nest 가 스스로 프로세스를 죽인다** —
   * 던지지 않으므로 아래 catch 가 돌지 못하고, 실패가 종료 코드 1 로만 남는다.
   * DB 가 안 떠 있을 때 정확히 그렇게 조용히 죽었다 (두 번 겪었다).
   */
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
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
  const schemas = (doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, Record<string, unknown>> }>;
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [prop, raw] of Object.entries(schema.properties ?? {})) {
      const spec = raw ?? {};
      const keys = Object.keys(spec).filter((k) => k !== 'description' && k !== 'nullable');
      // ① 아예 비어 있는 스키마
      if (keys.length === 0) { bare.push(`${name}.${prop} (빈 스키마)`); continue; }
      // ② 속이 없는 object — `string | null` 같은 유니온에 타입을 안 적으면 여기로 떨어진다.
      //    빈 스키마가 아니라서 ①에 안 걸리고, 프론트 타입은 Record<string, never> 가 된다.
      const isBlankObject =
        spec.type === 'object' &&
        !spec.properties && !spec.additionalProperties && !spec.$ref && !spec.allOf && !spec.oneOf;
      if (isBlankObject) bare.push(`${name}.${prop} (속 없는 object — 유니온에 타입을 안 적었다)`);
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

/*
 * **왜 죽었는지 말하게 한다.**
 * 전에는 `void main()` 이라 실패가 조용했다 — DB 가 안 떠 있으면(AppModule 이 붙지 못한다)
 * 아무 말 없이 종료 코드 1 만 남기고 openapi.json 은 **옛 내용 그대로** 남는다.
 * 그걸 모르고 다음 단계(`types:gen`)로 넘어가면 프론트가 옛 계약으로 컴파일된다.
 * 두 번 겪었다.
 */
main().catch((e: unknown) => {
  const msg = (e as Error).message;
  console.error(`\n✗ openapi.json 을 만들지 못했습니다 — ${msg}`);
  if (/ECONNREFUSED|connect|password|database/i.test(msg)) {
    console.error('  DB 에 못 붙었습니다. AppModule 을 띄우려면 DB 가 떠 있어야 합니다.');
  }
  console.error('  openapi.json 은 **고치지 않았습니다** — 옛 내용 그대로입니다.\n');
  process.exit(1);
});
