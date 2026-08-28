"""erd.dbml → TypeORM 엔티티 + 마이그레이션.

손으로 62표를 옮기면 반드시 어긋난다. dbml 이 정본이므로 여기서 읽어 만든다.
GPA 4표는 N-13 결정 대기라 제외한다 (규칙 P-1).
"""
import io, re, json, os

SRC = io.open('/tmp/erd.dbml', encoding='utf-8').read()

SKIP = {'GPASVC', 'GPA_CYCLE', 'GPA_ALLOC', 'GPA_USE'}   # N-13 대기

# ── enum 수집
enums = {}
for m in re.finditer(r'^Enum\s+(\w+)\s*\{([^}]*)\}', SRC, re.M):
    enums[m.group(1)] = m.group(2).split()

# ── 테이블 수집 (멀티라인 Note 를 건너뛰며)
def strip_notes(block):
    return re.sub(r"Note:\s*'''.*?'''", '', block, flags=re.S)

tables = []
i = 0
while True:
    m = re.search(r'^Table\s+(\w+)\s*\{', SRC[i:], re.M)
    if not m: break
    name = m.group(1)
    start = i + m.end()
    depth = 1
    j = start
    while depth:
        if SRC[j] == '{': depth += 1
        elif SRC[j] == '}': depth -= 1
        j += 1
    body = SRC[start:j-1]
    i = j
    tables.append((name, body))

TYPE_MAP = [
    (r'^bigserial$',       ('bigint',      'number', 'pk-gen')),
    (r'^serial$',          ('int',         'number', 'pk-gen')),
    (r'^bigint$',          ('bigint',      'number', None)),
    (r'^int$',             ('int',         'number', None)),
    (r'^smallint$',        ('smallint',    'number', None)),
    (r'^boolean$',         ('boolean',     'boolean', None)),
    (r'^text$',            ('text',        'string', None)),
    (r'^jsonb$',           ('jsonb',       'Record<string, unknown>', None)),
    (r'^date$',            ('date',        'string', None)),
    (r'^timestamptz$',     ('timestamptz', 'Date',   None)),
    (r'^tstzrange$',       ('tstzrange',   'string', None)),
    (r'^bytea$',           ('bytea',       'Buffer', None)),
    (r'^numeric\((\d+),(\d+)\)$', ('numeric', 'string', 'numeric')),
    (r'^varchar\((\d+)\)$',('varchar',     'string', 'len')),
    (r'^char\((\d+)\)$',   ('char',        'string', 'len')),
]

# 줄바꿈을 삼키지 않도록 [ \t] 만 쓴다. \s 를 쓰면 앞 컬럼 매치가 다음 줄의 들여쓰기까지
# 먹어 버려서 그 다음 컬럼이 통째로 사라진다 (STAFF.role 이 실제로 그렇게 빠졌다).
COL_RE = re.compile(r'(?<![\w.])(\w+)[ \t]+(bigserial|serial|bigint|int|smallint|boolean|text|jsonb|date|timestamptz|numeric\(\d+,\d+\)|varchar\(\d+\)|char\(\d+\)|tstzrange|bytea|\w+_t)[ \t]*(\[[^\]]*\])?')

DROPPED = []

def parse_cols(body):
    """한 줄짜리 표(CONS_STU 등)도 있으므로 줄 단위가 아니라 본문 전체에서 찾는다."""
    # indexes { … } 와 Note 는 컬럼이 아니다 — 먼저 지운다
    b = re.sub(r'indexes\s*\{[^}]*\}', ' ', body)
    b = re.sub(r"Note:\s*'[^']*'", ' ', b)
    b = re.sub(r'^\s*//.*$', ' ', b, flags=re.M)
    out = []
    for m in COL_RE.finditer(b):
        c = parse_col_m(m)
        if c: out.append(c)

    # COL_RE 는 타입 allowlist 다. 목록에 없는 타입은 **조용히 사라진다** —
    # SER_OCC.span(tstzrange) 이 실제로 그렇게 빠져 있었다 (TBO-25 에서 발견).
    # 그래서 컬럼처럼 생겼는데 못 잡은 줄을 찾아 알린다.
    got = {c['name'] for c in out}
    # 줄 전체가 「이름 타입 [속성]」 꼴인 것만 컬럼 후보로 본다.
    # Note 안의 한국어 산문이 걸리지 않도록 ASCII 로 못 박고 줄 끝까지 고정한다.
    CAND = re.compile(r'^([a-z_][a-z0-9_]*)[ \t]+([a-z][a-z0-9_]*(?:\(\d+(?:,\d+)?\))?)[ \t]*(\[[^\]]*\])?[ \t]*$')
    for line in b.split('\n'):
        mm = CAND.match(line.strip())
        if mm and mm.group(1) not in got and mm.group(1) != 'indexes':
            DROPPED.append((mm.group(1), mm.group(2)))
    return out

def parse_col_m(m):
    name, typ, attrs = m.group(1), m.group(2), m.group(3) or ''
    col = {'name': name, 'dbml': typ, 'attrs': attrs}
    for pat, (pg, ts, kind) in TYPE_MAP:
        mm = re.match(pat, typ)
        if mm:
            col.update(pg=pg, ts=ts, kind=kind, args=mm.groups())
            break
    else:
        if typ in enums:
            col.update(pg='enum', ts='|'.join(f"'{v}'" for v in enums[typ]), kind='enum', args=(typ,))
        else:
            col.update(pg='varchar', ts='string', kind='len', args=('40',))
    col['pk'] = 'pk' in attrs
    col['notnull'] = 'not null' in attrs or col['pk']
    col['unique'] = re.search(r'\bunique\b', attrs) is not None
    dm = re.search(r"default:\s*(`[^`]*`|'[^']*'|[\w.]+)", attrs)
    col['default'] = dm.group(1) if dm else None
    rm = re.search(r'ref:\s*>\s*(\w+)\.(\w+)', attrs)
    col['ref'] = (rm.group(1), rm.group(2)) if rm else None
    nm = re.search(r"note:\s*'((?:[^'\\]|\\.)*)'", attrs)
    col['note'] = nm.group(1).replace("\\'", "'") if nm else None
    return col

def pascal(s):
    return ''.join(p.capitalize() if not p.isupper() or len(p) > 3 else p.title()
                   for p in s.split('_')) if '_' in s else (s.title() if s.isupper() else s)

def entity_class(t):
    # KIND → Kind, SER_STU → SerStu, EXC_STU_OUT → ExcStuOut, INV_LINE → InvLine
    return ''.join(p.capitalize() for p in t.lower().split('_'))

def camel(s):
    p = s.split('_')
    return p[0] + ''.join(x.capitalize() for x in p[1:])

out_tables = []
for name, body in tables:
    if name in SKIP: continue
    cols = parse_cols(body)
    idx = []
    for m in re.finditer(r'indexes\s*\{([^}]*)\}', body):
        for line in m.group(1).split('\n'):
            line = line.strip()
            for im in re.finditer(r'\(([^)]*)\)(\s*\[unique\])?', line):
                fields = [f.strip() for f in im.group(1).split(',') if f.strip()]
                if fields: idx.append({'fields': fields, 'unique': bool(im.group(2)), 'pk': '[pk]' in line})
    out_tables.append({'table': name, 'cls': entity_class(name), 'cols': cols, 'idx': idx})

json.dump(out_tables, io.open('/tmp/tables.json','w',encoding='utf-8'), ensure_ascii=False, indent=1)
print('표', len(out_tables), '· 컬럼', sum(len(t['cols']) for t in out_tables))
if DROPPED:
    import sys
    print('\n⛔ 타입을 몰라서 버린 컬럼이 있습니다 — 생성물이 erd 와 어긋납니다:')
    for n, t in DROPPED: print(f'   {n} : {t}')
    print('   dbml-parse.py 의 COL_RE 와 TYPE_MAP 에 타입을 추가하세요.')
    sys.exit(1)
print('제외:', sorted(SKIP))
