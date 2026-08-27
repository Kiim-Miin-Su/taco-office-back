import io, json, os, re

T = json.load(io.open('/tmp/tables.json', encoding='utf-8'))
OUT = '/home/claude/out/app/taco_office_back/src/entities'
os.makedirs(OUT, exist_ok=True)

def camel(s):
    p = s.split('_'); return p[0] + ''.join(x.capitalize() for x in p[1:])

def file_of(t): return t['table'].lower().replace('_', '-') + '.entity.ts'

def col_decorator(c, table, is_pk=False):
    o = []
    if c['pg'] == 'enum':
        o.append(f"type: 'enum'")
        o.append(f"enum: {c['args'][0].upper()}_VALUES")
    elif c['kind'] == 'len':
        o.append(f"type: '{c['pg']}'"); o.append(f"length: {c['args'][0]}")
    elif c['kind'] == 'numeric':
        o.append("type: 'numeric'"); o.append(f"precision: {c['args'][0]}"); o.append(f"scale: {c['args'][1]}")
    else:
        o.append(f"type: '{c['pg']}'")
    # PK 는 nullable 일 수 없다 — dbml 에 not null 이 안 적혀 있어도 PK 면 강제한다
    if not c['notnull'] and not is_pk: o.append('nullable: true')
    if c['unique']: o.append('unique: true')
    d = c['default']
    if d:
        if d.startswith('`'):
            o.append(f"default: () => \"{d.strip('`')}\"")
        elif d.startswith("'"):
            o.append(f"default: {d}")
        elif d in ('true', 'false'):
            o.append(f"default: {d}")
        else:
            o.append(f"default: {d}")
    return '{ ' + ', '.join(o) + ' }'

def ts_type(c, is_pk=False):
    t = c['ts']
    if not c['notnull'] and not is_pk: t += ' | null'
    return t

enum_consts = {}
for t in T:
    for c in t['cols']:
        if c['pg'] == 'enum':
            enum_consts[c['args'][0]] = c['ts']

# ── enums 파일
lines = ["/**",
 " * DB enum — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.",
 " * 손으로 고치지 마세요. dbml 을 고치고 `npm run entities:gen` 을 다시 도세요.",
 " */", ""]
for name, ts in sorted(enum_consts.items()):
    vals = [v.strip().strip("'") for v in ts.split('|')]
    U = name.upper()
    lines.append(f"export const {U}_VALUES = [{', '.join(repr(v).replace(chr(39), chr(39)) for v in vals)}] as const;")
    lines.append(f"export type {''.join(p.capitalize() for p in name.split('_'))} = (typeof {U}_VALUES)[number];")
    lines.append("")
io.open(os.path.join(OUT, 'enums.ts'), 'w', encoding='utf-8').write('\n'.join(lines))

index = []
for t in T:
    cls, table, cols, idx = t['cls'], t['table'], t['cols'], t['idx']
    used_enums = sorted({c['args'][0].upper() + '_VALUES' for c in cols if c['pg'] == 'enum'})
    imports = ['Entity']
    pk_gen = [c for c in cols if c['kind'] == 'pk-gen']
    pk_plain = [c for c in cols if c['pk'] and c['kind'] != 'pk-gen']
    composite = [i for i in idx if i.get('pk')]
    if pk_gen: imports.append('PrimaryGeneratedColumn')
    if pk_plain or composite: imports.append('PrimaryColumn')
    plain_idx = [i for i in idx if not i.get('pk')]
    if plain_idx: imports.append('Index')
    pk_names_pre = {c['name'] for c in cols if c['pk']} | {f for i in composite for f in i['fields']}
    if any(c['name'] not in pk_names_pre and c['kind'] != 'pk-gen' for c in cols):
        imports.append('Column')

    L = []
    L.append('/**')
    L.append(f' * {table} — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.')
    L.append(' *')
    L.append(' * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).')
    L.append(' * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.')
    L.append(' */')
    L.append(f"import {{ {', '.join(sorted(set(imports)))} }} from 'typeorm';")
    if used_enums:
        L.append(f"import {{ {', '.join(used_enums)} }} from './enums';")
    L.append('')
    for i in plain_idx:
        f = ', '.join(f"'{camel(x)}'" for x in i['fields'])
        L.append(f"@Index([{f}]{', { unique: true }' if i['unique'] else ''})")
    L.append(f"@Entity({{ name: '{table.lower()}' }})")
    L.append(f'export class {cls} {{')
    pk_names = {c['name'] for c in cols if c['pk']}
    if composite:
        pk_names |= {f for i in composite for f in i['fields']}
    for c in cols:
        if c['note']:
            L.append(f"  /** {c['note']} */")
        if c['kind'] == 'pk-gen':
            L.append(f"  @PrimaryGeneratedColumn({{ type: 'bigint' }})")
        elif c['name'] in pk_names:
            L.append(f"  @PrimaryColumn({col_decorator(c, table, is_pk=True)})")
        else:
            L.append(f"  @Column({col_decorator(c, table)})")
        L.append(f"  {camel(c['name'])}: {ts_type(c, c['name'] in pk_names)};")
        L.append('')
    if L[-1] == '': L.pop()
    L.append('}')
    L.append('')
    io.open(os.path.join(OUT, file_of(t)), 'w', encoding='utf-8').write('\n'.join(L))
    index.append((cls, file_of(t)[:-3]))

ix = ["/** 엔티티 색인 — dbml v4.1 에서 생성했습니다. 손으로 고치지 마세요. */", "export * from './enums';"]
for cls, f in sorted(index):
    ix.append(f"export * from './{f}';")
ix.append('')
ix.append('import {')
for cls, _ in sorted(index):
    ix.append(f'  {cls},')
ix.append("} from './index';")
ix.append('')
ix.append('/** DataSource 에 넘길 목록. GPA 4표는 N-13 결정 대기라 빠져 있습니다. */')
ix.append('export const ENTITIES = [')
for cls, _ in sorted(index):
    ix.append(f'  {cls},')
ix.append('];')
ix.append('')
io.open(os.path.join(OUT, 'index.ts'), 'w', encoding='utf-8').write('\n'.join(ix))
print('엔티티', len(index), '개 생성')
