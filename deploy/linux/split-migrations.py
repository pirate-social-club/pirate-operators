#!/usr/bin/python3 -B
"""Split selected immutable SQL using SQLite completeness, without opening a DB."""
from pathlib import Path
import hashlib, json, re, sqlite3, sys
root = Path(sys.argv[1]).resolve(strict=True)
names = json.loads(sys.argv[2])
web2 = len(sys.argv) == 4 and sys.argv[3] == 'web2-first-song/1'
assert len(sys.argv) == 3 or web2
overlays = ['packages/community/catalog-phase-rebuild.sql',
            'packages/community/catalog-obligation.sql', 'packages/community/native-business.sql']
assert names == overlays if web2 else len(names) == len(set(names)) and names == sorted(names)
rows = []
for name in names:
    assert name in overlays if web2 else re.fullmatch(r'[0-9]{4}_[a-z0-9_]+\.sql', name)
    path = root / name; assert not path.is_symlink() and path.is_file()
    raw = path.read_bytes(); sql = raw.decode('utf-8'); assert '\x00' not in sql
    statements, pending = [], ''
    for char in sql:
        pending += char
        if char == ';' and sqlite3.complete_statement(pending):
            statements.append(pending); pending = ''
    tail = re.sub(r'/\*.*?\*/|--[^\n]*', '', pending, flags=re.S).strip()
    assert not tail and statements, 'Unterminated SQL or empty migration: ' + name
    statements[-1] += pending
    assert ''.join(statements) == sql
    rows.append({'name': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'sql': sql, 'statements': statements})
print(json.dumps(rows))
